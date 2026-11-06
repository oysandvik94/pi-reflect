/**
 * Reflect core logic — all pure/testable functions.
 * The extension entry point (index.ts) wires these into the pi extension API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";

// --- Paths ---

const HOME = process.env.HOME ?? "~";
const CONFIG_DIR = path.join(HOME, ".pi", "agent");
const CONFIG_FILE = path.join(CONFIG_DIR, "reflect.json");
const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, "reflect-backups");
const HISTORY_FILE = path.join(CONFIG_DIR, "reflect-history.json");

// --- Types ---

export interface TranscriptSource {
	type: "pi-sessions" | "command";
	/** Shell command that outputs transcript text to stdout. `{lookbackDays}` is interpolated. */
	command?: string;
}

export interface ContextSource {
	type: "files" | "command" | "url";
	/** Label shown in the context block (e.g. "daily logs", "recent conversations") */
	label?: string;
	/** For "files": glob patterns or file paths. */
	paths?: string[];
	/** For "command": shell command. `{lookbackDays}` is interpolated. */
	command?: string;
	/** For "url": HTTP GET endpoint. `{lookbackDays}` is interpolated. */
	url?: string;
	/** Max bytes to read from this source (default: 100KB) */
	maxBytes?: number;
}

export interface ReflectTarget {
	path: string;
	schedule: "daily" | "manual";
	model: string;
	reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	lookbackDays: number;
	maxSessionBytes: number;
	backupDir: string;
	/** Transcript sources. Can be a single TranscriptSource (legacy) or array of ContextSource[].
	 *  Multiple sources are concatenated with --- separators. */
	transcriptSource?: TranscriptSource;
	transcripts?: ContextSource[];
	/** Custom prompt template. Use {fileName}, {targetContent}, {transcripts}, {context} as placeholders.
	 *  If omitted, uses the default correction-pattern prompt. */
	prompt?: string;
	/** Additional context sources to read and inject. Available via {context} placeholder in prompts.
	 *  Each source has a type: "files" (glob/paths), "command" (shell, stdout), or "url" (HTTP GET). */
	context?: ContextSource[];
}

export interface ReflectConfig {
	targets: ReflectTarget[];
}

export interface EditRecord {
	type: "strengthen" | "add" | "remove" | "merge";
	section: string;
	reason: string;
}

export interface Evidence {
	id: string;
	sessionId: string;
	messageId: string;
	timestamp: string;
	quote: string;
	isNew: boolean;
}

export interface Proposal {
	type: AnalysisEdit["type"];
	section: string;
	oldText: string;
	newText: string;
	reason: string;
	evidenceIds: string[];
	status: "applied" | "skipped" | "approval_required" | "proposed";
	approvalReason?: string;
	ruleId: string;
}

export interface ReflectRun {
	status?: "success" | "partial" | "failed" | "no_data";
	invocationId?: string;
	sessionsExtracted?: number;
	successfulBatches?: number;
	failedBatches?: number;
	proposals?: Proposal[];
	evidence?: Evidence[];
	durationMs?: number;
	dryRun?: boolean;
	backupPath?: string;
	targetBeforeHash?: string;
	targetAfterHash?: string;
	model?: string;
	reasoning?: ReflectTarget["reasoning"];
	truncatedSessions?: number;
	failureReasons?: string[];
	usage?: { input: number; output: number; cost: number };
	proposedCount?: number;
	skippedCount?: number;
	timestamp: string;
	targetPath: string;
	sessionsAnalyzed: number;
	correctionsFound: number;
	editsApplied: number;
	summary: string;
	diffLines: number;
	correctionRate: number | null;
	edits?: EditRecord[];
	sourceDate?: string;
	date?: string; // legacy field from bash-script/batch runs
	/** File size metrics after this run */
	fileSize?: { chars: number; words: number; lines: number; estTokens: number };
}

export interface SessionExchange {
	role: "user" | "assistant";
	text: string | null;
	thinking: string | null;
	messageId?: string;
	timestamp?: string;
	sessionId?: string;
}

export interface SessionData {
	userCount: number;
	exchangeCount: number;
	transcript: string;
	size: number;
	project: string;
	time: string;
	userMessages?: SessionExchange[];
}

export interface TranscriptResult {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
	/** Individual sessions for chunked processing when transcripts exceed context budget */
	sessions?: SessionData[];
}

export interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}

export interface AnalysisEdit {
	type: "strengthen" | "add" | "remove" | "merge";
	section?: string;
	old_text?: string | null;
	new_text: string;
	after_text?: string | null;
	/** For "merge": array of exact text strings to remove (they're consolidated into new_text) */
	merge_sources?: string[];
	reason?: string;
	evidence?: { sessionId: string; messageId: string; timestamp: string; quote: string }[];
}

export interface ReflectionOptions {
	sourceDateOverride?: string;
	transcriptsOverride?: TranscriptResult;
	dryRun?: boolean;
	/** Override model — use the current session model instead of target.model */
	currentModel?: any;
	currentModelApiKey?: string;
	currentModelHeaders?: Record<string, string>;
}

export type NotifyFn = (msg: string, level: "info" | "warning" | "error") => void;

// --- Defaults ---

export const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: DEFAULT_BACKUP_DIR,
	transcriptSource: { type: "pi-sessions" },
};

export const MAX_ASSISTANT_MSG_CHARS = 2000;
export const MAX_THINKING_MSG_CHARS = 1500;

// --- File size metrics ---

export function computeFileMetrics(content: string): { chars: number; words: number; lines: number; estTokens: number } {
	const chars = content.length;
	const words = content.split(/\s+/).filter(Boolean).length;
	const lines = content.split("\n").length;
	// Rough estimate: ~4 chars per token for English/code mix
	const estTokens = Math.round(chars / 4);
	return { chars, words, lines, estTokens };
}

// --- Config ---

export function loadConfig(): ReflectConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			targets: (parsed.targets ?? []).map((t: any) => ({
				...DEFAULT_TARGET,
				...t,
			})),
		};
	} catch {
		return { targets: [] };
	}
}

export function saveConfig(config: ReflectConfig): void {
	fs.mkdirSync(CONFIG_DIR, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

export function loadHistory(): ReflectRun[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
	} catch {
		return [];
	}
}

export function saveHistory(runs: ReflectRun[]): void {
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(runs, null, 2), "utf-8");
}

// --- Helpers ---

export function resolvePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(HOME, p.slice(1));
	}
	return path.resolve(p);
}

export function formatTimestamp(): string {
	return new Date().toISOString().replace("T", "_").replace(/[:.]/g, "").slice(0, 15);
}

export function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function truncateText(text: string | null, limit: number): string | null {
	if (!text) return text;
	if (text.length > limit) {
		return text.slice(0, limit) + `\n[...truncated, ${text.length - limit} chars omitted]`;
	}
	return text;
}

// --- Session extraction ---

export function projectNameFromDir(dirname: string): string {
	let name = dirname;
	const user = process.env.USER ?? "user";
	const homePrefix = `--Users-${user}-`;
	if (name.startsWith(homePrefix)) {
		name = name.slice(homePrefix.length);
	}
	const linuxPrefix = `--home-${user}-`;
	if (name.startsWith(linuxPrefix)) {
		name = name.slice(linuxPrefix.length);
	}
	name = name.replace(/--/g, "/").replace(/^[-/]+|[-/]+$/g, "");
	return name || "workspace";
}

export async function extractTranscript(filepath: string): Promise<SessionExchange[]> {
	const exchanges: SessionExchange[] = [];
	let sessionId = createHash("sha256").update(path.resolve(filepath)).digest("hex").slice(0, 20);
	try {
		const rl = createInterface({ input: createReadStream(filepath), crlfDelay: Infinity });
		for await (const line of rl) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}

			if (entry.type === "session" && typeof entry.id === "string" && entry.id) { sessionId = entry.id; continue; }
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (!msg) continue;
			const role = msg.role;
			if (role !== "user" && role !== "assistant") continue;

			const content = msg.content;
			if (!Array.isArray(content)) continue;

			const textParts: string[] = [];
			const thinkingParts: string[] = [];

			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				if (part.type === "text" && part.text?.trim()) {
					textParts.push(part.text.trim());
				} else if (part.type === "thinking" && part.thinking?.trim()) {
					thinkingParts.push(part.thinking.trim());
				}
			}

			if (textParts.length === 0 && thinkingParts.length === 0) continue;

			exchanges.push({
				role,
				text: textParts.length > 0 ? textParts.join("\n") : null,
				thinking: thinkingParts.length > 0 ? thinkingParts.join("\n") : null,
				messageId: typeof entry.id === "string" ? entry.id : undefined,
				timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
				sessionId,
			});
		}
	} catch {
		// Skip unreadable files
	}
	return exchanges;
}

export function formatSessionTranscript(exchanges: SessionExchange[], sessionId: string, project: string): string {
	const lines: string[] = [];
	lines.push(`### Session: ${project} [${sessionId}]`);
	lines.push("");

	for (const ex of exchanges) {
		if (ex.role === "user") {
			lines.push(`**USER** [sessionId=${ex.sessionId ?? "unknown"} messageId=${ex.messageId ?? "unknown"} timestamp=${ex.timestamp ?? "unknown"}]: ${ex.text}`);
			lines.push("");
		} else if (ex.role === "assistant") {
			if (ex.thinking) {
				lines.push(`**THINKING:** ${truncateText(ex.thinking, MAX_THINKING_MSG_CHARS)}`);
				lines.push("");
			}
			if (ex.text) {
				lines.push(`**AGENT:** ${truncateText(ex.text, MAX_ASSISTANT_MSG_CHARS)}`);
				lines.push("");
			}
		}
	}

	return lines.join("\n");
}

// --- Shared session scanning logic ---

async function collectSessionsForDates(
	targetDates: string[],
	maxBytes: number,
	sessionsDir?: string,
): Promise<TranscriptResult> {
	const effectiveSessionsDir = sessionsDir ?? SESSIONS_DIR;

	const targetDateSet = new Set(targetDates);
	const earliestMtime = new Date(`${targetDates.slice().sort()[0]}T00:00:00Z`).getTime() - 86_400_000;

	const sessionDirs: string[] = [];
	try {
		for (const dir of fs.readdirSync(effectiveSessionsDir)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(effectiveSessionsDir, dir);
			if (fs.statSync(fullDir).isDirectory()) {
				sessionDirs.push(fullDir);
			}
		}
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}

	const allSessions: SessionData[] = [];
	let totalScanned = 0;

	for (const dir of sessionDirs) {
		const project = projectNameFromDir(path.basename(dir));
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
		} catch {
			continue;
		}

		for (const file of files) {
			const filepath = path.join(dir, file);
			try { if (fs.statSync(filepath).mtimeMs < earliestMtime) continue; } catch { continue; }
			totalScanned++;
			const allExchanges = await extractTranscript(filepath);
			const exchanges = allExchanges.filter((e) => {
				if (!e.timestamp) return false;
				const date = new Date(e.timestamp);
				if (!Number.isFinite(date.getTime())) return false;
				const localDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
				return targetDateSet.has(localDate);
			});
			const userCount = exchanges.filter((e) => e.role === "user").length;
			if (userCount < 1) continue;

			const sessionTime = file.slice(0, 19).replace("T", " ");
			const transcript = formatSessionTranscript(exchanges, sessionTime, project);

			allSessions.push({
				userCount,
				exchangeCount: exchanges.length,
				transcript,
				size: transcript.length,
				project,
				time: sessionTime,
				userMessages: exchanges.filter((e) => e.role === "user"),
			});
		}
	}

	if (allSessions.length === 0) {
		return { transcripts: "", sessionCount: totalScanned, includedCount: 0, sessions: [] };
	}

	allSessions.sort((a, b) => {
		const densityA = a.userCount / Math.max(a.exchangeCount, 1);
		const densityB = b.userCount / Math.max(b.exchangeCount, 1);
		if (densityB !== densityA) return densityB - densityA;
		return b.userCount - a.userCount;
	});

	const parts: string[] = [];
	let currentSize = 0;
	let included = 0;

	for (const sd of allSessions) {
		const entry = sd.transcript + "\n---\n\n";
		if (currentSize + entry.length > maxBytes) continue;
		parts.push(entry);
		currentSize += entry.length;
		included++;
	}

	const header =
		`# Session Transcripts\n` +
		`# Sessions scanned: ${totalScanned}, ${allSessions.length} with substantive conversation, ${included} included\n` +
		`# Total user messages: ${allSessions.reduce((s, sd) => s + sd.userCount, 0)}\n\n`;

	return {
		transcripts: header + parts.join(""),
		sessionCount: totalScanned,
		includedCount: included,
		sessions: allSessions,
	};
}

export async function collectTranscripts(lookbackDays: number, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	const targetDates: string[] = [];
	for (let i = 1; i <= lookbackDays; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		targetDates.push(d.toISOString().slice(0, 10));
	}
	return collectSessionsForDates(targetDates, maxBytes, sessionsDir);
}

export async function collectTranscriptsForDate(targetDate: string, maxBytes: number, sessionsDir?: string): Promise<TranscriptResult> {
	return collectSessionsForDates([targetDate], maxBytes, sessionsDir);
}

export async function collectTranscriptsFromCommand(command: string, lookbackDays: number, maxBytes: number): Promise<TranscriptResult> {
	const { execSync } = await import("node:child_process");
	const interpolated = command.replace(/\{lookbackDays\}/g, String(lookbackDays));

	try {
		let output = execSync(interpolated, {
			encoding: "utf-8",
			timeout: 60_000,
			maxBuffer: maxBytes * 2,
		});

		if (output.length > maxBytes) {
			output = output.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
		}

		const sessionMatches = output.match(/^### Session:/gm);
		const count = sessionMatches?.length ?? 1;

		return { transcripts: output, sessionCount: count, includedCount: count };
	} catch {
		return { transcripts: "", sessionCount: 0, includedCount: 0 };
	}
}

// --- Context collection ---

/** Compute the cutoff date string (YYYY-MM-DD) for lookbackDays ago */
function lookbackCutoff(lookbackDays: number): string {
	const d = new Date();
	d.setDate(d.getDate() - lookbackDays);
	return d.toISOString().slice(0, 10);
}

/** Check if a filename contains a date and whether it's within the lookback window */
function isWithinLookback(filename: string, cutoff: string): boolean {
	const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
	if (!match) return true; // no date in filename → include it
	return match[1] >= cutoff;
}

function findGlobBaseDir(globPattern: string): string {
	const normalized = path.normalize(globPattern);
	const segments = normalized.split(path.sep);
	const globIndex = segments.findIndex((segment) => segment.includes("*"));

	if (globIndex === -1) return path.dirname(normalized);

	const baseSegments = segments.slice(0, globIndex).filter(Boolean);
	if (normalized.startsWith(path.sep)) {
		return baseSegments.length > 0 ? path.join(path.sep, ...baseSegments) : path.sep;
	}
	return baseSegments.length > 0 ? path.join(...baseSegments) : ".";
}

function globToRegex(globPattern: string): RegExp {
	const normalized = globPattern.split(path.sep).join("/");
	const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	const globstarToken = "__PI_REFLECT_GLOBSTAR__";
	const withGlobstarToken = escaped.replace(/\*\*\/?/g, globstarToken);
	const withWildcards = withGlobstarToken.replace(/\*/g, "[^/]*");
	const withGlobstar = withWildcards.replaceAll(globstarToken, "(?:.*/)?");
	return new RegExp(`^${withGlobstar}$`);
}

function walkFilesRecursive(dir: string): string[] {
	const files: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...walkFilesRecursive(fullPath));
			} else if (entry.isFile()) {
				files.push(fullPath);
			}
		}
	} catch {}

	return files;
}

function findMatchingFiles(globPattern: string): { name: string; full: string }[] {
	const baseDir = findGlobBaseDir(globPattern);
	if (!fs.existsSync(baseDir)) return [];

	const relativePattern = path.relative(baseDir, globPattern);
	const relativeRegex = globToRegex(relativePattern);
	const basenameRegex = !relativePattern.includes(path.sep) ? globToRegex(path.basename(globPattern)) : null;

	return walkFilesRecursive(baseDir)
		.filter((fullPath) => {
			const relativePath = path.relative(baseDir, fullPath).split(path.sep).join("/");
			const baseName = path.basename(fullPath);
			return relativeRegex.test(relativePath) || (basenameRegex?.test(baseName) ?? false);
		})
		.map((fullPath) => ({
			name: path.relative(baseDir, fullPath).split(path.sep).join("/"),
			full: fullPath,
		}));
}

export async function collectContext(sources: ContextSource[], lookbackDays: number): Promise<string> {
	const parts: string[] = [];
	const cutoff = lookbackCutoff(lookbackDays);

	for (const source of sources) {
		const maxBytes = source.maxBytes ?? 100 * 1024;
		const label = source.label ?? source.type;
		let content = "";
		let totalBytes = 0;

		try {
			if (source.type === "files" && source.paths) {
				const fileParts: string[] = [];
				for (const pattern of source.paths) {
					const expanded = pattern.replace(/\{lookbackDays\}/g, String(lookbackDays));
					let candidates: { name: string; full: string }[] = [];

					if (expanded.includes("*")) {
						candidates = findMatchingFiles(expanded);
					} else if (fs.existsSync(expanded)) {
						candidates = [{ name: path.basename(expanded), full: expanded }];
					}

					// Prune by date, sort newest first
					candidates = candidates
						.filter(c => isWithinLookback(c.name, cutoff))
						.sort((a, b) => b.name.localeCompare(a.name));

					for (const c of candidates) {
						try {
							if (!fs.statSync(c.full).isFile()) continue;
							const fileContent = fs.readFileSync(c.full, "utf-8");
							if (totalBytes + fileContent.length > maxBytes) break;
							fileParts.push(`### ${c.name}\n${fileContent}`);
							totalBytes += fileContent.length;
						} catch {}
					}
				}
				content = fileParts.join("\n\n");
			} else if (source.type === "command" && source.command) {
				const { execSync } = await import("node:child_process");
				const interpolated = source.command.replace(/\{lookbackDays\}/g, String(lookbackDays));
				content = execSync(interpolated, {
					encoding: "utf-8",
					timeout: 30_000,
					maxBuffer: maxBytes * 2,
				});
			} else if (source.type === "url" && source.url) {
				const interpolated = source.url.replace(/\{lookbackDays\}/g, String(lookbackDays));
				const response = await fetch(interpolated, { signal: AbortSignal.timeout(15_000) });
				if (response.ok) {
					content = await response.text();
				}
			}
		} catch {}

		if (content) {
			if (content.length > maxBytes) {
				content = content.slice(0, maxBytes) + "\n\n[...truncated to fit context budget]";
			}
			parts.push(`## ${label}\n${content}`);
		}
	}

	return parts.join("\n\n---\n\n");
}

// --- Scan available session dates ---

export function getAvailableSessionDates(): string[] {
	const dates = new Set<string>();
	try {
		for (const dir of fs.readdirSync(SESSIONS_DIR)) {
			if (dir.includes("var-folders")) continue;
			const fullDir = path.join(SESSIONS_DIR, dir);
			if (!fs.statSync(fullDir).isDirectory()) continue;
			for (const file of fs.readdirSync(fullDir)) {
				if (!file.endsWith(".jsonl")) continue;
				const fileDate = file.slice(0, 10);
				if (/^\d{4}-\d{2}-\d{2}$/.test(fileDate)) {
					dates.add(fileDate);
				}
			}
		}
	} catch {}
	return [...dates].sort();
}

// --- LLM prompt ---

export function buildReflectionPrompt(targetPath: string, targetContent: string, transcripts: string): string {
	const fileName = path.basename(targetPath);
	return `You are reviewing recent agent session transcripts to improve ${fileName}.

Preserve existing rules and examples. Propose changes only for verified new corrections.

## Input

### Target file: ${fileName}
<target_file>
${targetContent}
</target_file>

### Session transcripts
<transcripts>
${transcripts}
</transcripts>

## Step 1: Identify Correction Patterns

Read the transcripts for genuine corrections — user redirecting the agent, expressing frustration, repeating themselves, or correcting approach. Ignore normal flow ("no worries", "actually that looks good").

For each correction: what the agent did wrong, what the user wanted, and which rule (if any) already covers it.

## Step 2: Propose evidence-backed edits

Four edit types available:
1. **strengthen**: Improve an existing rule only when new correction evidence supports the change.
2. **add**: Add a new rule for a pattern supported by corrections from at least two distinct sessions.
3. **remove**: Propose deletion only when supported by new correction evidence; approval is required.
4. **merge**: Propose consolidation only when supported by new correction evidence; approval is required.

Guidelines:
- Do not propose cosmetic edits without new evidence. Preserve existing safety clauses exactly.
- Every proposal must cite exact user correction quotes with sessionId, messageId and timestamp from the transcript.
- Don't reorganize or restructure the file. Minimal, targeted edits only.
- Sections whose heading contains "DO NOT EDIT" are maintained by the user and are READ-ONLY. Never propose strengthen/remove/merge/add edits whose anchors fall inside them, never shorten or move their examples, and do not duplicate their rules elsewhere. Edits touching them are rejected automatically.
- Copy anchors character-for-character from the target file. Do not abbreviate, paraphrase, truncate, normalize punctuation, or use ellipses in old_text, after_text, or merge_sources.
- If you cannot copy one unique exact anchor, return no edit for that pattern.

## Step 3: Output

IMPORTANT: Your ENTIRE response must be a single JSON object. No markdown, no preamble.

For "strengthen": old_text = COMPLETE bullet/rule copied exactly. new_text = evidence-backed replacement.
For "add": after_text = COMPLETE bullet/line copied exactly. new_text = concise new bullet (1-2 sentences).
For "remove": old_text = COMPLETE bullet/rule to delete. new_text = "" (empty string).
For "merge": merge_sources = array of COMPLETE bullets to consolidate. new_text = single concise replacement. The merged text replaces the first source; others are removed.

{
  "corrections_found": <number>,
  "sessions_with_corrections": <number>,
  "edits": [
    {
      "type": "strengthen" | "add" | "remove" | "merge",
      "section": "which section of the file",
      "old_text": "exact text to find (strengthen/remove) or null (add/merge)",
      "new_text": "replacement/new text, or empty string for remove",
      "after_text": "insertion point (add only) or null",
      "merge_sources": ["exact text 1", "exact text 2"] or null (merge only),
      "reason": "brief reason for this edit",
      "evidence": [{"sessionId":"exact sessionId", "messageId":"exact messageId", "timestamp":"exact timestamp", "quote":"exact USER correction quote"}]
    }
  ],
  "patterns_not_added": [
    { "pattern": "description", "reason": "why not added" }
  ],
  "summary": "2-3 sentence summary"
}`;
}

/** Build the prompt for a target. If target has a custom prompt, interpolate it. Otherwise use default. */
export function buildPromptForTarget(target: ReflectTarget, targetPath: string, targetContent: string, transcripts: string, context?: string): string {
	if (!target.prompt) {
		return buildReflectionPrompt(targetPath, targetContent, transcripts);
	}
	const fileName = path.basename(targetPath);
	return target.prompt
		.replace(/\{fileName\}/g, fileName)
		.replace(/\{targetContent\}/g, targetContent)
		.replace(/\{transcripts\}/g, transcripts)
		.replace(/\{context\}/g, context ?? "");
}

// --- Protected sections ---

/** True when the target file has uncommitted changes in its Git repository. */
export function hasUncommittedChanges(targetPath: string): boolean {
	try {
		const realPath = fs.realpathSync(targetPath);
		const repoDir = path.dirname(realPath);
		if (!fs.existsSync(path.join(repoDir, ".git"))) return false;
		const out = execFileSync("git", ["status", "--porcelain", "--", path.basename(realPath)], { cwd: repoDir, timeout: 5000 }).toString();
		return out.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * A Markdown section is protected when its heading contains "DO NOT EDIT" (for
 * example "## BEHAVIORAL REQUIREMENTS [DO NOT EDIT AS PART OF REFLECTION]"),
 * or when text is wrapped in <!-- reflect:protected --> ... <!-- /reflect:protected -->.
 * A heading-based section runs until the next heading of the same or higher level.
 */
export interface ProtectedRange {
	start: number;
	end: number; // exclusive
	text: string;
	label: string;
}

const PROTECTED_HEADING = /^(#{1,6})\s.*DO NOT EDIT/i;
const PROTECTED_OPEN = "<!-- reflect:protected -->";
const PROTECTED_CLOSE = "<!-- /reflect:protected -->";

export function findProtectedRanges(content: string): ProtectedRange[] {
	const ranges: ProtectedRange[] = [];
	const lines = content.split("\n");
	const offsets: number[] = [];
	let pos = 0;
	for (const line of lines) {
		offsets.push(pos);
		pos += line.length + 1;
	}

	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(PROTECTED_HEADING);
		if (!m) continue;
		const level = m[1].length;
		let j = i + 1;
		for (; j < lines.length; j++) {
			const h = lines[j].match(/^(#{1,6})\s/);
			if (h && h[1].length <= level) break;
		}
		const start = offsets[i];
		const end = j < lines.length ? offsets[j] : content.length;
		ranges.push({ start, end, text: content.slice(start, end), label: lines[i].trim() });
		i = j - 1;
	}

	let from = 0;
	while (true) {
		const open = content.indexOf(PROTECTED_OPEN, from);
		if (open === -1) break;
		const close = content.indexOf(PROTECTED_CLOSE, open);
		const end = close === -1 ? content.length : close + PROTECTED_CLOSE.length;
		ranges.push({ start: open, end, text: content.slice(open, end), label: "reflect:protected block" });
		from = end;
	}

	return ranges.sort((a, b) => a.start - b.start);
}

function anchorInProtected(content: string, anchor: string, ranges: ProtectedRange[]): ProtectedRange | null {
	const idx = content.indexOf(anchor);
	if (idx === -1) return null;
	const endIdx = idx + anchor.length;
	for (const r of ranges) {
		if (idx < r.end && endIdx > r.start) return r;
	}
	return null;
}

function editTouchesProtected(content: string, edit: AnalysisEdit, ranges: ProtectedRange[]): string | null {
	if (ranges.length === 0) return null;
	const anchors: string[] = [];
	if (edit.old_text) anchors.push(edit.old_text);
	if (edit.after_text) anchors.push(edit.after_text);
	if (edit.merge_sources) anchors.push(...edit.merge_sources);
	for (const a of anchors) {
		const hit = anchorInProtected(content, a, ranges);
		if (hit) return hit.label;
	}
	return null;
}

function protectedIntact(result: string, ranges: ProtectedRange[]): boolean {
	return ranges.every((r) => result.includes(r.text));
}

// --- Edit application ---

export function applyEdits(content: string, edits: AnalysisEdit[]): EditResult {
	let result = content;
	let applied = 0;
	const skipped: string[] = [];
	const protectedRanges = findProtectedRanges(content);

	for (const edit of edits) {
		const protectedLabel = editTouchesProtected(result, edit, protectedRanges);
		if (protectedLabel) {
			skipped.push(`Refused edit inside protected section (${protectedLabel}): ${JSON.stringify(edit.reason ?? edit.type).slice(0, 80)}`);
			continue;
		}
		const before = result;
		const appliedBefore = applied;

		if (edit.type === "strengthen" && edit.old_text && edit.new_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to strengthen: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			if (edit.old_text.length > 50) {
				const checkSnippet = edit.old_text.slice(0, 50);
				const occurrences = (edit.new_text.match(new RegExp(escapeRegex(checkSnippet), "g")) || []).length;
				if (occurrences > 1) {
					skipped.push(`Duplication detected in replacement text: "${edit.old_text.slice(0, 80)}..."`);
					continue;
				}
			}

			result = result.replace(edit.old_text, edit.new_text);
			applied++;
		} else if (edit.type === "add" && edit.new_text && edit.after_text) {
			if (!result.includes(edit.after_text)) {
				skipped.push(`Could not find insertion point: "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.after_text);
			const secondIdx = result.indexOf(edit.after_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous insertion point (appears multiple times): "${edit.after_text.slice(0, 80)}..."`);
				continue;
			}

			if (result.includes(edit.new_text.trim())) {
				skipped.push(`Text already exists in file: "${edit.new_text.trim().slice(0, 80)}..."`);
				continue;
			}

			result = result.replace(edit.after_text, edit.after_text + "\n" + edit.new_text);
			applied++;
		} else if (edit.type === "remove" && edit.old_text) {
			if (!result.includes(edit.old_text)) {
				skipped.push(`Could not find text to remove: "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			const firstIdx = result.indexOf(edit.old_text);
			const secondIdx = result.indexOf(edit.old_text, firstIdx + 1);
			if (secondIdx !== -1) {
				skipped.push(`Ambiguous match for removal (appears multiple times): "${edit.old_text.slice(0, 80)}..."`);
				continue;
			}

			// Remove the text and any trailing blank line
			result = result.replace(edit.old_text + "\n", "");
			if (result.includes(edit.old_text)) {
				result = result.replace(edit.old_text, "");
			}
			applied++;
		} else if (edit.type === "merge" && edit.merge_sources && edit.merge_sources.length > 0 && edit.new_text) {
			// Remove all source texts, then insert the consolidated new_text where the first source was
			let firstSourceIdx = Infinity;
			let firstSourceText = "";
			let allFound = true;

			for (const src of edit.merge_sources) {
				if (!result.includes(src)) {
					skipped.push(`Merge source not found: "${src.slice(0, 80)}..."`);
					allFound = false;
					break;
				}
				const idx = result.indexOf(src);
				if (idx < firstSourceIdx) {
					firstSourceIdx = idx;
					firstSourceText = src;
				}
			}
			if (!allFound) continue;

			// Replace the first source with the merged text
			result = result.replace(firstSourceText, edit.new_text);
			// Remove the remaining sources
			for (const src of edit.merge_sources) {
				if (src === firstSourceText) continue;
				result = result.replace(src + "\n", "");
				if (result.includes(src)) {
					result = result.replace(src, "");
				}
			}
			applied++;
		} else {
			skipped.push(`Invalid edit: ${JSON.stringify(edit).slice(0, 100)}`);
		}

		// Hard guarantee: protected text must survive every edit byte-for-byte.
		if (applied > appliedBefore && !protectedIntact(result, protectedRanges)) {
			result = before;
			applied = appliedBefore;
			skipped.push(`Reverted edit that altered a protected section: ${JSON.stringify(edit.reason ?? edit.type).slice(0, 80)}`);
		}
	}

	return { result, applied, skipped };
}

// --- Batch helpers ---

/** Split sessions into batches that each fit within maxBytes */
export function buildTranscriptBatches(sessions: SessionData[], maxBytes: number): string[][] {
	const batches: string[][] = [];
	let currentBatch: string[] = [];
	let currentSize = 0;

	for (const sd of sessions) {
		let entry = sd.transcript + "\n---\n\n";
		// A single long session can exceed the batch budget by itself. Truncate it
		// rather than sending an oversized request that the provider must reject.
		if (entry.length > maxBytes) {
			const notice = "\n\n[...session truncated to fit the reflection context budget]\n---\n\n";
			entry = entry.slice(0, maxBytes - notice.length) + notice;
		}
		if (currentSize + entry.length > maxBytes && currentBatch.length > 0) {
			batches.push(currentBatch);
			currentBatch = [];
			currentSize = 0;
		}
		currentBatch.push(entry);
		currentSize += entry.length;
	}
	if (currentBatch.length > 0) {
		batches.push(currentBatch);
	}
	return batches;
}

function formatBatchTranscripts(parts: string[], batchIndex: number, totalBatches: number, totalSessions: number): string {
	const header =
		`# Session Transcripts (batch ${batchIndex + 1}/${totalBatches})\n` +
		`# ${parts.length} sessions in this batch, ${totalSessions} total\n\n`;
	return header + parts.join("");
}

interface AnalysisResult {
	edits: AnalysisEdit[];
	correctionsFound: number;
	sessionsWithCorrections: number;
	summary: string;
	patternsNotAdded?: any[];
	usage?: { input: number; output: number; cost: number };
}

/** Run a single LLM analysis call on one batch of transcripts */
export function buildReflectAnalysisTool() {
	return {
		name: "submit_analysis",
		description: "Submit the reflection analysis results",
		parameters: {
			type: "object" as const,
			properties: {
				corrections_found: { type: "number", description: "Number of facts/rules added, updated, or removed" },
				sessions_with_corrections: { type: "number", description: "Number of conversations containing new facts or corrections" },
				edits: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["strengthen", "add", "remove", "merge"], description: "strengthen = update existing text, add = insert new text, remove = delete redundant text, merge = consolidate multiple rules into one" },
							section: { type: "string", description: "Which section of the file" },
							old_text: { type: "string", description: "Exact text to find for strengthen or remove; omit otherwise" },
							new_text: { type: "string", description: "Replacement/new text, or empty string for remove" },
							after_text: { type: "string", description: "Exact insertion point for add; omit otherwise" },
							merge_sources: { type: "array", items: { type: "string" }, description: "Exact source texts for merge; omit otherwise" },
							reason: { type: "string", description: "Brief reason for this edit" },
							evidence: { type: "array", items: { type: "object", properties: {
								sessionId: { type: "string" }, messageId: { type: "string" }, timestamp: { type: "string" }, quote: { type: "string" },
							}, required: ["sessionId", "messageId", "timestamp", "quote"] } },
						},
						required: ["type", "new_text"],
					},
				},
				patterns_not_added: {
					type: "array",
					items: {
						type: "object",
						properties: {
							pattern: { type: "string" },
							reason: { type: "string" },
						},
					},
				},
				summary: { type: "string", description: "2-3 sentence summary of what was added/updated" },
			},
			required: ["corrections_found", "sessions_with_corrections", "edits", "summary"],
		},
	};
}

async function analyzeTranscriptBatch(
	target: ReflectTarget,
	targetPath: string,
	targetContent: string,
	transcripts: string,
	context: string,
	model: any,
	apiKey: string,
	headers: Record<string, string> | undefined,
	modelLabel: string,
	notify: NotifyFn,
	completeFn: (model: any, request: any, options: any) => Promise<any>,
	anchorFailures: string[] = [],
): Promise<AnalysisResult | null> {
	const prompt = buildPromptForTarget(target, targetPath, targetContent, transcripts, context)
		+ (anchorFailures.length > 0
			? `\n\n## Required retry\nYour prior edit anchors did not exactly match the target file:\n${anchorFailures.map((failure) => `- ${failure}`).join("\n")}\nReturn only edits with anchors copied character-for-character from <target_file>. Do not abbreviate, paraphrase, or use ellipses. If there is no exact unique anchor, return no edit.`
			: "");

	const reflectAnalysisTool = buildReflectAnalysisTool();

	const response = await completeFn(model, {
		systemPrompt: "Analyze user corrections, preserve safety rules, and propose only evidence-backed improvements. Cite exact USER messages. Call the submit_analysis tool.",
		messages: [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: prompt }],
				timestamp: Date.now(),
			},
		],
		tools: [reflectAnalysisTool],
	}, { apiKey, headers, maxTokens: 16384, reasoning: target.reasoning });

	if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
		const category = /(?:unsupported|not supported|invalid).{0,60}(?:reasoning|thinking)|(?:reasoning|thinking).{0,60}(?:unsupported|not supported|invalid)/i.test(String(response.errorMessage ?? "")) ? "unsupported reasoning" : "provider failure";
		notify(`LLM analysis failed (${category}; stopReason=${response.stopReason}).`, "error");
		return null;
	}

	let analysis: any;
	const toolCall = response.content.find((c: any) => c.type === "toolCall" && c.name === "submit_analysis");
	if (toolCall && (toolCall as any).arguments) {
		analysis = (toolCall as any).arguments;
	} else {
		const responseText = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		try {
			const jsonStr = responseText.replace(/^```json?\s*\n?/m, "").replace(/\n?```\s*$/m, "");
			analysis = JSON.parse(jsonStr);
		} catch {
			notify("Failed to parse LLM analysis response.", "error");
			return null;
		}
	}

	const validCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
	const validEdit = (edit: any) => edit && ["add", "strengthen", "remove", "merge"].includes(edit.type) && typeof edit.new_text === "string"
		&& (edit.section == null || typeof edit.section === "string") && (edit.reason == null || typeof edit.reason === "string")
		&& (edit.type !== "add" || typeof edit.after_text === "string")
		&& (!["strengthen", "remove"].includes(edit.type) || typeof edit.old_text === "string")
		&& (edit.type !== "merge" || (Array.isArray(edit.merge_sources) && edit.merge_sources.every((s: unknown) => typeof s === "string")))
		&& Array.isArray(edit.evidence) && edit.evidence.every((e: any) => e && [e.sessionId, e.messageId, e.timestamp, e.quote].every((v) => typeof v === "string"));
	if (!analysis || !Array.isArray(analysis.edits) || !analysis.edits.every(validEdit) || !validCount(analysis.corrections_found) || !validCount(analysis.sessions_with_corrections) || typeof analysis.summary !== "string") {
		notify("LLM analysis response is incomplete.", "error");
		return null;
	}
	return {
		edits: analysis.edits,
		correctionsFound: analysis.corrections_found ?? 0,
		sessionsWithCorrections: analysis.sessions_with_corrections ?? 0,
		summary: analysis.summary ?? "",
		patternsNotAdded: analysis.patterns_not_added,
		usage: typeof response.usage?.input === "number" && typeof response.usage?.output === "number" && typeof response.usage?.cost?.total === "number"
			? { input: response.usage.input, output: response.usage.output, cost: response.usage.cost.total } : undefined,
	};
}

// --- Main reflection logic ---

export async function resolveModelAuth(
	modelRegistry: any,
	model: any,
): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error?: string }> {
	if (!modelRegistry) return { ok: false, error: "model registry unavailable" };
	if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
		const auth = await modelRegistry.getApiKeyAndHeaders(model);
		return auth?.ok
			? { ok: true, apiKey: auth.apiKey, headers: auth.headers }
			: { ok: false, error: auth?.error };
	}
	if (typeof modelRegistry.getApiKey === "function") {
		const apiKey = await modelRegistry.getApiKey(model);
		return apiKey ? { ok: true, apiKey } : { ok: false, error: "No API key" };
	}
	return { ok: false, error: "unsupported model registry" };
}

export interface RunReflectionDeps {
	completeSimple: (model: any, request: any, options: any) => Promise<any>;
	getModel: (provider: string, modelId: string) => any;
	loadHistoryFn?: () => ReflectRun[];
	collectTranscriptsFn?: (lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
	collectTranscriptsFromCommandFn?: (command: string, lookbackDays: number, maxBytes: number) => Promise<TranscriptResult>;
}

export async function runReflection(
	target: ReflectTarget,
	modelRegistry: any,
	notify: NotifyFn,
	deps?: RunReflectionDeps,
	options?: ReflectionOptions,
): Promise<ReflectRun> {
	const started = Date.now();
	const targetPath = resolvePath(target.path);
	const run: ReflectRun = {
		timestamp: new Date(started).toISOString(), targetPath, status: "failed", dryRun: !!options?.dryRun, model: target.model, reasoning: target.reasoning, failureReasons: [],
		sourceDate: options?.sourceDateOverride ?? new Date(started - target.lookbackDays * 86_400_000).toISOString().slice(0, 10),
		sessionsExtracted: 0, sessionsAnalyzed: 0, successfulBatches: 0, failedBatches: 0,
		correctionsFound: 0, editsApplied: 0, proposedCount: 0, skippedCount: 0,
		summary: "Reflection failed.", diffLines: 0, correctionRate: null, proposals: [], evidence: [],
	};
	const finish = (status: NonNullable<ReflectRun["status"]>, summary: string): ReflectRun => {
		run.status = status;
		if (status === "failed" || status === "partial") notify(summary.slice(0, 200), "error");
		run.summary = summary.slice(0, 1000);
		run.durationMs = Date.now() - started;
		if (status !== "success") run.correctionRate = null;
		return run;
	};
	try {
		if (!fs.existsSync(targetPath)) return finish("failed", "Target file not found.");
		const original = fs.readFileSync(targetPath, "utf-8");
		run.targetBeforeHash = createHash("sha256").update(original).digest("hex");
		if (original.length < 100) return finish("failed", "Target file too small.");
		let collected: TranscriptResult;
		if (options?.transcriptsOverride) collected = options.transcriptsOverride;
		else if (target.transcripts?.length) {
			const transcripts = await collectContext(target.transcripts, target.lookbackDays);
			collected = { transcripts, sessionCount: transcripts ? 1 : 0, includedCount: transcripts ? 1 : 0 };
		} else if (target.transcriptSource?.type === "command" && target.transcriptSource.command) {
			collected = await (deps?.collectTranscriptsFromCommandFn ?? collectTranscriptsFromCommand)(target.transcriptSource.command, target.lookbackDays, target.maxSessionBytes);
		} else collected = await (deps?.collectTranscriptsFn ?? collectTranscripts)(target.lookbackDays, target.maxSessionBytes);
		const sessions = collected.sessions;
		run.sessionsExtracted = sessions?.length ?? collected.includedCount;
		if (!collected.transcripts || !run.sessionsExtracted) return finish("no_data", "No substantive sessions found.");

		const [provider, modelId] = target.model.split("/", 2);
		const model = options?.currentModel ?? modelRegistry?.find?.(provider, modelId) ?? (deps?.getModel ?? (await import("@earendil-works/pi-ai/compat")).getModel)(provider, modelId);
		if (!model) return finish("failed", "Configured model not found.");
		let completeFn: (model: any, request: any, options: any) => Promise<any>;
		let apiKey = options?.currentModelApiKey;
		let headers = options?.currentModelHeaders;
		if (deps?.completeSimple) completeFn = deps.completeSimple;
		else if (typeof modelRegistry?.streamSimple === "function") {
			completeFn = async (m, request, opts) => modelRegistry.streamSimple(m, request, { maxTokens: opts.maxTokens, reasoning: opts.reasoning }).result();
		} else {
			const auth = await resolveModelAuth(modelRegistry, model);
			if (!auth.ok) return finish("failed", "Model authentication unavailable.");
			apiKey = auth.apiKey; headers = auth.headers;
			completeFn = (await import("@earendil-works/pi-ai/compat")).completeSimple;
		}
		const context = target.context?.length ? await collectContext(target.context, target.lookbackDays) : "";
		const budget = Math.max(target.maxSessionBytes - original.length - context.length - 20_000, 100_000);
		const batches = sessions?.length ? buildTranscriptBatches(sessions, budget) : [[collected.transcripts]];
		run.truncatedSessions = sessions?.filter((s) => s.transcript.length + 6 > budget).length ?? 0;
		const oldEvidence = new Set((deps?.loadHistoryFn ?? loadHistory)().filter((r) => r.targetPath === targetPath && r.status === "success" && !r.dryRun)
			.flatMap((r) => (r.proposals ?? []).filter((p) => p.status === "applied").flatMap((p) => p.evidenceIds)));
		const messages = sessions?.flatMap((s) => s.userMessages ?? []) ?? [];
		let staged = original;
		const summaries: string[] = [];
		for (let i = 0; i < batches.length; i++) {
			const transcript = sessions?.length ? formatBatchTranscripts(batches[i], i, batches.length, sessions.length) : batches[i][0];
			let result: AnalysisResult | null;
			try {
				result = await analyzeTranscriptBatch(target, targetPath, staged, transcript, context, model, apiKey ?? "", headers, target.model, (message, level) => {
					if (level === "error") run.failureReasons!.push(message.slice(0, 200));
					notify(message, level);
				}, completeFn);
			} catch { run.failureReasons!.push("Model request failed before completion."); result = null; }
			if (!result) { run.failedBatches!++; continue; }
			run.successfulBatches!++;
			run.sessionsAnalyzed += sessions?.length ? batches[i].length : collected.includedCount;
			run.correctionsFound += result.correctionsFound;
			if (result.usage) {
				run.usage ??= { input: 0, output: 0, cost: 0 };
				run.usage.input += result.usage.input; run.usage.output += result.usage.output; run.usage.cost += result.usage.cost;
			}
			if (result.summary) summaries.push(result.summary);
			for (const edit of result.edits) {
				const oldText = edit.old_text ?? edit.merge_sources?.join("\n") ?? "";
				const proposal: Proposal = { type: edit.type, section: edit.section ?? "", oldText, newText: edit.new_text ?? "", reason: edit.reason ?? "", evidenceIds: [], status: "skipped", ruleId: createHash("sha256").update(oldText || edit.new_text || "").digest("hex").slice(0, 20) };
				run.proposals!.push(proposal);
				for (const item of Array.isArray(edit.evidence) ? edit.evidence : []) {
					if (!item || typeof item.quote !== "string" || !item.quote.trim()) continue;
					const message = messages.find((m) => m.sessionId === item.sessionId && m.messageId === item.messageId && m.timestamp === item.timestamp && m.text?.includes(item.quote) && transcript.includes(item.quote) && transcript.includes(`sessionId=${m.sessionId} messageId=${m.messageId} timestamp=${m.timestamp}`));
					if (!message) continue;
					const id = createHash("sha256").update(`${item.sessionId}:${item.messageId}`).digest("hex").slice(0, 24);
					proposal.evidenceIds.push(id);
					if (!run.evidence!.some((e) => e.id === id)) run.evidence!.push({ id, sessionId: item.sessionId, messageId: item.messageId, timestamp: item.timestamp, quote: item.quote, isNew: !oldEvidence.has(id) });
				}
				if (!proposal.evidenceIds.some((id) => !oldEvidence.has(id))) { proposal.approvalReason = "No verified new user correction evidence."; continue; }
				const freshEvidence = run.evidence!.filter((e) => proposal.evidenceIds.includes(e.id) && e.isNew);
				if (edit.type === "add" && (new Set(freshEvidence.map((e) => e.sessionId)).size < 2 || new Set(freshEvidence.map((e) => e.messageId)).size < 2)) { proposal.approvalReason = "Addition requires new corrections from two distinct sessions and messages."; continue; }
				if (edit.type !== "add" || /\b(?:permission\w*|authori[sz]\w*|approv\w*|secur\w*|safet\w*|scope\w*|never|must not|do not|don't|forbid\w*|credential\w*|secret\w*|deploy\w*|commit\w*|push\w*|delet\w*|destruct\w*|external\w*|sandbox\w*|branch\w*|pull request\w*|pr\b|shared state|checkpoint\w*)\b/i.test(`${oldText}\n${edit.new_text}`)) {
					proposal.status = "approval_required"; proposal.approvalReason = "Removal, merge, replacement, or sensitive rule requires approval."; continue;
				}
				const applied = applyEdits(staged, [edit]);
				if (!applied.applied || applied.result === staged) { proposal.approvalReason = applied.skipped[0] ?? "No effective change."; continue; }
				staged = applied.result;
				proposal.status = "proposed";
				for (const id of proposal.evidenceIds) oldEvidence.add(id);
			}
		}
		run.proposedCount = run.proposals!.length;
		run.skippedCount = run.proposals!.filter((p) => p.status === "skipped" || p.status === "approval_required").length;
		if (run.failedBatches) return finish(run.successfulBatches ? "partial" : "failed", "Analysis incomplete; no changes applied.");
		if (staged.length < original.length * 0.5) return finish("failed", "Proposed result is suspiciously small; no changes applied.");
		if (!options?.dryRun && staged !== original) {
			if (fs.readFileSync(targetPath, "utf-8") !== original) return finish("failed", "Target changed during analysis; no changes applied.");
			const dir = resolvePath(target.backupDir);
			fs.mkdirSync(dir, { recursive: true });
			const backupPath = path.join(dir, `${path.basename(targetPath, ".md")}_${formatTimestamp()}_${Date.now()}.md`);
			fs.writeFileSync(backupPath, original, { flag: "wx" });
			if (fs.readFileSync(targetPath, "utf-8") !== original) return finish("failed", "Target changed before write; no changes applied.");
			const realTarget = fs.realpathSync(targetPath);
			const tempPath = path.join(path.dirname(realTarget), `.${path.basename(realTarget)}.${randomUUID()}.tmp`);
			try {
				const mode = fs.statSync(realTarget).mode & 0o7777;
				fs.writeFileSync(tempPath, staged, { flag: "wx", mode });
				fs.chmodSync(tempPath, mode);
				if (fs.readFileSync(targetPath, "utf-8") !== original) return finish("failed", "Target changed before write; no changes applied.");
				fs.renameSync(tempPath, realTarget);
			} finally {
				try { fs.unlinkSync(tempPath); } catch { /* renamed or never created */ }
			}
			run.backupPath = backupPath;
			run.targetAfterHash = createHash("sha256").update(staged).digest("hex");
			for (const proposal of run.proposals!) if (proposal.status === "proposed") { proposal.status = "applied"; run.editsApplied++; }
		}
		if (staged !== original && !options?.dryRun) {
			const before = original.split("\n"), after = staged.split("\n");
			for (let i = 0; i < Math.max(before.length, after.length); i++) if (before[i] !== after[i]) run.diffLines++;
		}
		run.correctionRate = run.sessionsAnalyzed ? run.correctionsFound / run.sessionsAnalyzed : null;
		run.fileSize = computeFileMetrics(options?.dryRun ? original : staged);
		return finish("success", summaries.join(" ") || "Analysis complete.");
	} catch {
		notify("Reflection failed during collection or application; no further changes attempted.", "error");
		return finish("failed", "Reflection failed during collection or application.");
	}
}

// Re-export path constants for the extension entry point
export { CONFIG_FILE, CONFIG_DIR, SESSIONS_DIR, DEFAULT_BACKUP_DIR, HISTORY_FILE, HOME };
