import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runReflection, resolveModelAuth, type ReflectTarget } from "../extensions/reflect.ts";

function setup() {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflect-run-"));
 const file = path.join(dir, "AGENTS.md"); fs.writeFileSync(file, "# Instructions\n" + "Keep useful context. ".repeat(10));
 const target: ReflectTarget = { path: file, backupDir: path.join(dir, "backup"), model: "test/model", reasoning: "high", schedule: "manual", lookbackDays: 7, maxSessionBytes: 100000 };
 const transcriptsOverride = { transcripts: "test", sessionCount: 1, includedCount: 1 };
 return { target, transcriptsOverride };
}
const notify = () => {};
const empty = { stopReason: "toolUse", content: [{ type: "toolCall", name: "submit_analysis", arguments: { corrections_found: 0, sessions_with_corrections: 0, edits: [], summary: "No changes" } }] };

test("missing target, no data and missing model have explicit outcomes", async () => {
 const { target, transcriptsOverride } = setup();
 assert.equal((await runReflection({ ...target, path: target.path + ".missing" }, {}, notify)).status, "failed");
 assert.equal((await runReflection(target, {}, notify, undefined, { transcriptsOverride: { transcripts: "", sessionCount: 0, includedCount: 0 } })).status, "no_data");
 const missing = await runReflection(target, { find: () => null }, notify, { getModel: () => null, completeSimple: async () => empty }, { transcriptsOverride });
 assert.equal(missing.status, "failed"); assert.equal(missing.sessionsAnalyzed, 0); assert.equal(missing.correctionRate, null);
});

test("registered provider stream receives target reasoning and usage", async () => {
 const { target, transcriptsOverride } = setup(); let opts: any;
 const registry = { find: () => ({ provider: "test", id: "model" }), streamSimple: (_model: unknown, _req: unknown, options: unknown) => { opts = options; return { result: async () => ({ ...empty, usage: { input: 2, output: 3, cost: { total: 0.1 } } }) }; } };
 const run = await runReflection(target, registry, notify, undefined, { transcriptsOverride });
 assert.equal(run.status, "success"); assert.equal(opts.reasoning, "high"); assert.deepEqual(run.usage, { input: 2, output: 3, cost: 0.1 });
});

test("malformed or errored analysis is not success", async () => {
 const { target, transcriptsOverride } = setup();
 for (const response of [{ content: [{ type: "text", text: "{}" }] }, { stopReason: "error", content: [] }, { ...empty, stopReason: "length" }, { content: [{ type: "text", text: '{"corrections_found":-1,"sessions_with_corrections":0,"edits":[],"summary":"bad"}' }] }]) {
  const run = await runReflection(target, { find: () => ({}) }, notify, { getModel: () => null, completeSimple: async () => response }, { transcriptsOverride });
  assert.equal(run.status, "failed"); assert.equal(run.correctionRate, null); assert.equal(run.failedBatches, 1);
 }
});

test("authentication resolver accepts header-only and legacy keys", async () => {
 assert.deepEqual(await resolveModelAuth({ getApiKeyAndHeaders: async () => ({ ok: true, headers: { "X-Test": "value" } }) }, {}), { ok: true, apiKey: undefined, headers: { "X-Test": "value" } });
 assert.deepEqual(await resolveModelAuth({ getApiKey: async () => "key" }, {}), { ok: true, apiKey: "key" });
});
