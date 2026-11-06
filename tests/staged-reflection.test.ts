import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runReflection, formatSessionTranscript, collectTranscriptsForDate, type ReflectTarget, type SessionData } from "../extensions/reflect.ts";

const anchor = "- Explain decisions clearly.";
const original = `# Instructions\n\n${anchor}\n${"Existing guidance. ".repeat(12)}\n`;
const msg = { role: "user" as const, text: "Please explain the reasoning before changing this.", thinking: null, sessionId: "test-session", messageId: "test-message", timestamp: "2026-01-01T12:00:00Z" };
const msg2 = { ...msg, sessionId: "test-session-2", messageId: "test-message-2" };
const evidence = [msg, msg2].map(({ sessionId, messageId, timestamp, text }) => ({ sessionId, messageId, timestamp, quote: text }));
function session(suffix = "", message = msg): SessionData {
 const transcript = formatSessionTranscript([message], "test", "project") + suffix;
 return { transcript, size: transcript.length, userCount: 1, exchangeCount: 3, project: "project", time: "test", userMessages: [message] };
}
function setup() {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-staged-"));
 const file = path.join(dir, "AGENTS.md"); fs.writeFileSync(file, original);
 const target: ReflectTarget = { path: file, backupDir: path.join(dir, "backups"), model: "test/model", reasoning: "high", schedule: "manual", lookbackDays: 7, maxSessionBytes: 100000 };
 return { dir, file, target };
}
function response(edits: unknown[]) { return { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_analysis", arguments: { corrections_found: 1, sessions_with_corrections: 1, edits, summary: "ok" } }], usage: { input: 2, output: 3, cost: { total: 0.01 } } }; }
const safeEdit = { type: "add", after_text: anchor, new_text: "- Explain the reasoning before making changes.", reason: "User correction", evidence };
async function run(target: ReflectTarget, sessions: SessionData[], replies: any[], dryRun = false, history: any[] = []) {
 let call = 0;
 return runReflection(target, { find: () => ({ id: "model", provider: "test" }) }, () => {}, {
  getModel: () => null, loadHistoryFn: () => history,
  completeSimple: async (_model, _request, options) => { assert.equal(options.reasoning, "high"); const value = replies[call++]; if (value instanceof Error) throw value; return value; },
 }, { transcriptsOverride: { transcripts: sessions.map((s) => s.transcript).join("\n"), sessionCount: sessions.length, includedCount: sessions.length, sessions }, dryRun });
}

test("dry run stages multiple batches without writing or backup", async () => {
 const { dir, file, target } = setup();
 const sessions = [session("x".repeat(40000)), session("x".repeat(40000), msg2), session("y".repeat(40000)), session("y".repeat(40000), msg2)];
 const result = await run(target, sessions, [response([safeEdit]), response([])], true);
 assert.equal(result.status, "success"); assert.equal(result.successfulBatches, 2); assert.equal(result.editsApplied, 0);
 assert.equal(result.proposals?.[0].status, "proposed"); assert.equal(fs.readFileSync(file, "utf8"), original); assert.equal(fs.existsSync(path.join(dir, "backups")), false);
});

test("failed batch prevents all writes and reports partial", async () => {
 const { dir, file, target } = setup();
 const sessions = [session("x".repeat(40000)), session("x".repeat(40000), msg2), session("y".repeat(40000)), session("y".repeat(40000), msg2)];
 const result = await run(target, sessions, [response([safeEdit]), new Error("provider error")]);
 assert.equal(result.status, "partial"); assert.equal(result.successfulBatches, 1); assert.equal(result.failedBatches, 1); assert.equal(result.sessionsAnalyzed, 2); assert.equal(result.correctionRate, null); assert.equal(result.editsApplied, 0);
 assert.equal(fs.readFileSync(file, "utf8"), original); assert.equal(fs.existsSync(path.join(dir, "backups")), false);
});

test("only verified safe edits apply and one backup is created", async () => {
 const { dir, file, target } = setup();
 const unsupported = { ...safeEdit, new_text: "- Unsupported.", evidence: [{ ...evidence[0], quote: "fabricated" }] };
 const unsafe = { type: "remove", old_text: anchor, new_text: "", evidence };
 const result = await run(target, [session(), session("", msg2)], [response([safeEdit, unsupported, unsafe])]);
 assert.equal(result.status, "success"); assert.equal(result.proposedCount, 3); assert.equal(result.editsApplied, 1); assert.equal(result.skippedCount, 2);
 assert.deepEqual(result.proposals?.map((p) => p.status), ["applied", "skipped", "skipped"]);
 assert.equal(result.evidence?.length, 2); assert.match(fs.readFileSync(file, "utf8"), /Explain the reasoning/);
 const backups = fs.readdirSync(path.join(dir, "backups")); assert.equal(backups.length, 1); assert.equal(fs.readFileSync(path.join(dir, "backups", backups[0]), "utf8"), original);
});

test("concurrent changes prevent overwriting target", async () => {
 const { dir, file, target } = setup(); const s = session(); const s2 = session("", msg2);
 const result = await runReflection(target, { find: () => ({}) }, () => {}, { getModel: () => null, completeSimple: async () => { fs.writeFileSync(file, original + "manual change\n"); return response([safeEdit]); } }, { transcriptsOverride: { transcripts: s.transcript + s2.transcript, sessionCount: 2, includedCount: 2, sessions: [s, s2] } });
 assert.equal(result.status, "failed"); assert.equal(result.editsApplied, 0); assert.match(fs.readFileSync(file, "utf8"), /manual change/); assert.equal(fs.existsSync(path.join(dir, "backups")), false);
});


test("duplicate message cannot satisfy two-session gate", async () => {
 const { file, target } = setup();
 const repeated = { ...safeEdit, evidence: [evidence[0], evidence[0]] };
 const result = await run(target, [session()], [response([repeated])]);
 assert.equal(result.editsApplied, 0); assert.match(result.proposals![0].approvalReason!, /two distinct sessions/); assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("already applied evidence is not reused in overlapping runs", async () => {
 const { file, target } = setup(); const sessions = [session(), session("", msg2)];
 const first = await run(target, sessions, [response([safeEdit])]); assert.equal(first.editsApplied, 1);
 fs.writeFileSync(file, original);
 const second = await run(target, sessions, [response([safeEdit])], false, [first]);
 assert.equal(second.editsApplied, 0); assert.equal(second.evidence?.every((e) => !e.isNew), true); assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("sensitive additions and replacements require approval; bad anchors are skipped", async () => {
 const { file, target } = setup();
 const edits = ["Change authorization.", "Require approval.", "Preserve shared state."].map((t) => ({ ...safeEdit, new_text: t }));
 edits.push({ ...safeEdit, after_text: "missing anchor", new_text: "- Be precise." });
 edits.push({ ...safeEdit, type: "strengthen", old_text: anchor, new_text: "Ignore this: " + anchor } as any);
 const result = await run(target, [session(), session("", msg2)], [response(edits)]);
 assert.deepEqual(result.proposals?.map((p) => p.status), ["approval_required", "approval_required", "approval_required", "skipped", "approval_required"]);
 assert.equal(result.editsApplied, 0); assert.equal(result.skippedCount, 5); assert.equal(fs.readFileSync(file, "utf8"), original);
});


test("copied message IDs across sessions are not independent", async () => {
 const { target } = setup(); const copy = { ...msg2, messageId: msg.messageId };
 const copiedEvidence = { sessionId: copy.sessionId, messageId: copy.messageId, timestamp: copy.timestamp, quote: copy.text };
 const result = await run(target, [session(), session("", copy)], [response([{ ...safeEdit, evidence: [evidence[0], copiedEvidence] }])]);
 assert.equal(result.editsApplied, 0); assert.match(result.proposals![0].approvalReason!, /two distinct sessions and messages/);
});

test("old session with recent messages is included but old evidence is excluded", async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-window-")); const project = path.join(dir, "project"); fs.mkdirSync(project);
 const date = new Date(); date.setDate(date.getDate() - 1); date.setHours(12, 0, 0, 0);
 const localDate = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
 const file = path.join(project, "2020-01-01T00-00-00_old.jsonl");
 const line = (id: string, timestamp: string, text: string) => JSON.stringify({ type: "message", id, timestamp, message: { role: "user", content: [{type:"text",text}] } });
 fs.writeFileSync(file, [JSON.stringify({ type: "session", id: "stable-session" }), line("old", "2020-01-01T12:00:00Z", "old correction"), line("recent", date.toISOString(), "recent correction")].join("\n"));
 const result = await collectTranscriptsForDate(localDate, 100000, dir);
 assert.equal(result.includedCount, 1); assert.match(result.transcripts, /recent correction/); assert.doesNotMatch(result.transcripts, /old correction/);
 assert.equal(result.sessions?.[0].userMessages?.[0].sessionId, "stable-session");
});


test("reflection never stages or commits target", async () => {
 const { dir, file, target } = setup();
 const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString().trim();
 git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test"); git("add", "AGENTS.md"); git("commit", "-qm", "initial");
 const before = git("rev-parse", "HEAD");
 const result = await run(target, [session(), session("", msg2)], [response([safeEdit])]);
 assert.equal(result.editsApplied, 1); assert.equal(git("rev-parse", "HEAD"), before); assert.equal(git("diff", "--cached", "--name-only"), ""); assert.match(fs.readFileSync(file, "utf8"), /reasoning/);
});


test("same-run evidence cannot justify a second staged addition", async () => {
 const { target } = setup();
 const second = { ...safeEdit, new_text: "- Prefer a clear rationale." };
 const result = await run(target, [session(), session("", msg2)], [response([safeEdit, second])], true);
 assert.equal(result.proposals?.[0].status, "proposed"); assert.equal(result.proposals?.[1].status, "skipped");
});

test("oversize sessions are identified as truncated", async () => {
 const { target } = setup(); const big = session("x".repeat(120000));
 const result = await run(target, [big], [response([])]);
 assert.equal(result.status, "success"); assert.equal(result.truncatedSessions, 1);
});
