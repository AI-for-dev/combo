/**
 * The check port, running real scripts.
 *
 * `bash` is on every machine this runs on, and no network is involved.
 * Mocking the child process here would test nothing: what matters is that a
 * failing script comes back as `passed: false` with its output intact, which is
 * precisely what a mock would assume.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bashCheck } from "../src/verify.ts";

const cwd = process.cwd();

describe("bashCheck", () => {
	const check = (content: string, timeoutMs = 10_000) => bashCheck()({ script: "tests.sh", content, cwd, timeoutMs });

	test("mixes stdout and stderr in the order they came", async () => {
		assert.deepEqual(await check("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three"), { ok: true, passed: true, report: "one\ntwo\nthree" });
	});

	test("keeps the last 8000 bytes, saying how much was cut, however long the output ran", async () => {
		const result = await check("for i in $(seq 1 20000); do echo \"line $i\"; done; echo THE FAILURE >&2; exit 3");
		assert.ok(result.ok && !result.passed);
		const written = Array.from({ length: 20000 }, (_, i) => `line ${i + 1}\n`).join("").length + "THE FAILURE".length;
		assert.match(result.ok ? result.report : "", new RegExp(`^\\[…${written - 8000} bytes cut\\]\\n[\\s\\S]*line 20000\\nTHE FAILURE$`));
		assert.equal(result.ok && result.report.split("\n").slice(1).join("\n").length, 8000);
	});
});
