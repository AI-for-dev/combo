/**
 * A notification fitted before pi draws it: a path is never cut in two, and
 * the `Error: ` pi writes before the first line is counted in its room.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitted } from "../extension/notice.ts";

describe("fitted", () => {
	const missing = "ENOENT: no such file or directory, open '/elsewhere/combo/runs/2026-09-24_00-00-16/snapshot.json'";

	test("cuts before a path, which goes on whole on the next line, under the text", () => {
		assert.deepEqual(fitted(missing, "/repo", "info", 72).split("\n"), [
			"ENOENT: no such file or directory, open",
			"  '/elsewhere/combo/runs/2026-09-24_00-00-16/snapshot.json'",
		]);
	});

	test("counts what pi writes before the first line at its level", () => {
		const line = "run: runs/2026-09-24_00-00-16 cannot be resumed - the run already ended well";
		assert.deepEqual(fitted(line, "/repo", "info", 80).split("\n"), [line]);
		const warned = fitted(line, "/repo", "warning", 80).split("\n");
		assert.ok(`Warning: ${warned[0]}`.length <= 78, warned[0]);
		assert.equal(warned.join(" ").replace(/\s+/g, " "), line);
	});

	test("names a path inside the working directory from there", () => {
		assert.equal(fitted("open '/repo/runs/x/snapshot.json'", "/repo", "error", 80), "open 'runs/x/snapshot.json'");
	});

	test("leaves a message alone when the terminal's width is unknown", () => {
		assert.equal(fitted(missing, "/repo", "error", undefined), missing);
	});
});
