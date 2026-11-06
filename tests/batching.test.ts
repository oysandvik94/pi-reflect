import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { buildTranscriptBatches, type SessionData } from "../extensions/reflect.js";

// --- buildTranscriptBatches tests ---

function makeSession(id: string, sizeBytes: number): SessionData {
	const transcript = "x".repeat(sizeBytes);
	return {
		transcript,
		project: "test-project",
		sessionId: id,
		date: "2026-02-20",
		size: sizeBytes,
	};
}

describe("buildTranscriptBatches", () => {
	it("puts all sessions in one batch when they fit", () => {
		const sessions = [makeSession("a", 100), makeSession("b", 100), makeSession("c", 100)];
		const batches = buildTranscriptBatches(sessions, 1000);
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 3);
	});

	it("splits sessions across batches when they exceed maxBytes", () => {
		const sessions = [makeSession("a", 500), makeSession("b", 500), makeSession("c", 500)];
		// Each entry is transcript + "\n---\n\n" = 506 bytes
		const batches = buildTranscriptBatches(sessions, 600);
		assert.equal(batches.length, 3);
		assert.equal(batches[0].length, 1);
		assert.equal(batches[1].length, 1);
		assert.equal(batches[2].length, 1);
	});

	it("groups multiple small sessions into one batch", () => {
		const sessions = [
			makeSession("a", 100),
			makeSession("b", 100),
			makeSession("c", 100),
			makeSession("d", 100),
		];
		// Each entry ~106 bytes, 4 × 106 = 424 bytes
		const batches = buildTranscriptBatches(sessions, 250);
		assert.equal(batches.length, 2);
		assert.equal(batches[0].length, 2);
		assert.equal(batches[1].length, 2);
	});

	it("returns empty array for empty sessions", () => {
		const batches = buildTranscriptBatches([], 1000);
		assert.equal(batches.length, 0);
	});

	it("handles a single session larger than maxBytes", () => {
		const sessions = [makeSession("a", 2000)];
		const batches = buildTranscriptBatches(sessions, 500);
		// Single session still gets its own batch even if it exceeds budget
		assert.equal(batches.length, 1);
		assert.equal(batches[0].length, 1);
	});

	it("preserves session order across batches", () => {
		const sessions = [
			{ ...makeSession("1st", 300), transcript: "FIRST_SESSION_CONTENT" + "x".repeat(279) },
			{ ...makeSession("2nd", 300), transcript: "SECOND_SESSION_CONTENT" + "x".repeat(278) },
			{ ...makeSession("3rd", 300), transcript: "THIRD_SESSION_CONTENT" + "x".repeat(279) },
		];
		const batches = buildTranscriptBatches(sessions, 400);
		assert.equal(batches.length, 3);
		assert.ok(batches[0][0].includes("FIRST_SESSION"));
		assert.ok(batches[1][0].includes("SECOND_SESSION"));
		assert.ok(batches[2][0].includes("THIRD_SESSION"));
	});

	it("each entry includes separator suffix", () => {
		const sessions = [makeSession("a", 50)];
		const batches = buildTranscriptBatches(sessions, 1000);
		assert.ok(batches[0][0].endsWith("\n---\n\n"));
	});
});
