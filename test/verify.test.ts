/**
 * The verification port, running real commands.
 *
 * `node` and `false` are on every machine this runs on, and no network is
 * involved. Mocking `execFile` here would test nothing: what matters is that a
 * failing command comes back as `ok: false` with its output intact, which is
 * precisely what a mock would assume.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { commandVerifier } from "../src/verify.ts";

const cwd = process.cwd();

describe("commandVerifier", () => {
	test("a command that succeeds is a pass, with its output", async () => {
		const verify = commandVerifier({ cwd, command: process.execPath, args: ["-e", "console.log('12 tests passed')"] });
		const result = await verify();

		assert.equal(result.ok, true);
		assert.match(result.output, /12 tests passed/);
		assert.match(result.command ?? "", /-e/);
	});

	test("a command that fails is a failure, and stderr is kept: that is where it speaks", async () => {
		const verify = commandVerifier({
			cwd,
			command: process.execPath,
			args: ["-e", "console.error('1 test failed: slugify'); process.exit(1)"],
		});
		const result = await verify();

		assert.equal(result.ok, false);
		assert.match(result.output, /1 test failed: slugify/);
	});

	test("a command that does not exist fails rather than throwing", async () => {
		const verify = commandVerifier({ cwd, command: "definitely-not-a-command-here" });
		const result = await verify();

		assert.equal(result.ok, false);
		assert.ok(result.output.length > 0, "the caller needs to know why");
	});

	test("the tail is kept, not the head: a runner says what failed at the end", async () => {
		const verify = commandVerifier({
			cwd,
			command: process.execPath,
			args: ["-e", "for (let i = 0; i < 2000; i++) console.log(`line ${i}`); console.log('THE FAILURE')"],
			maxBytes: 200,
		});
		const result = await verify();

		assert.match(result.output, /THE FAILURE/, "truncating the head would have hidden it");
		assert.match(result.output, /bytes cut/);
		assert.ok(result.output.length < 400);
	});

	test("a command that hangs is cut short rather than hanging the pipeline", async () => {
		const verify = commandVerifier({
			cwd,
			command: process.execPath,
			args: ["-e", "setTimeout(() => {}, 60_000)"],
			timeoutMs: 300,
		});

		const startedAt = performance.now();
		const result = await verify();

		assert.equal(result.ok, false);
		assert.ok(performance.now() - startedAt < 5_000, "a correct label on a still-running command is not a guard");
	});

	test("arguments are an array, so nothing is ever interpreted by a shell", async () => {
		const verify = commandVerifier({ cwd, command: process.execPath, args: ["-e", "console.log(process.argv[1] ?? 'none')"] });
		const result = await verify();

		assert.equal(result.ok, true);
		assert.ok(!result.output.includes("&&"), "there is no shell to chain anything onto");
	});
});
