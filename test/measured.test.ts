/**
 * A measured run, on real files: the report it leaves is the whole point.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import type { SubagentEvent } from "../src/events.ts";
import { measuredRun } from "../src/measure/measured.ts";
import { closed, spawned } from "./fixtures/picture.ts";

const scratch: string[] = [];
afterEach(() => {
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-measured-"));
	scratch.push(dir);
	return dir;
}

const report = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "usage.json"), "utf8"));

describe("measuredRun", () => {
	test("folds the stream into a picture, and finishing writes usage.json with the time measured", async () => {
		const dir = tmpDir();
		const run = measuredRun({ dir });

		run.onEvent(spawned("scout#1"));
		// Measured on the clock the run reads, so the bound holds whatever the
		// timer's granularity.
		const before = performance.now();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const slept = performance.now() - before;
		run.onEvent(closed("scout#1", true, { input: 100 }));
		const finished = run.finish();

		assert.equal(finished.total.subagents, 1);
		assert.equal(finished.total.input, 100);
		assert.ok(finished.wallMs >= slept, "the wall time is the measurement's own clock");
		assert.equal(report(dir).total.input, 100);
	});

	test("every listener hears the same stream, after the picture", () => {
		const heard: string[] = [];
		const run = measuredRun({ listeners: [(event) => void heard.push(`a:${event.type}`), undefined, (event) => void heard.push(`b:${event.type}`)] });

		run.onEvent(spawned("scout#1"));

		assert.deepEqual(heard, ["a:spawn", "b:spawn"]);
		assert.equal(run.picture.snapshot().total, 1, "and the picture saw it first");
	});

	test("with no directory nothing is written, and the report still comes back", () => {
		const run = measuredRun();
		run.onEvent(spawned("scout#1"));
		assert.equal(run.finish().total.subagents, 1);
	});

	test("keeps the stream on disk when asked, beside the report", () => {
		const dir = tmpDir();
		const run = measuredRun({ dir, record: true });

		run.onEvent(spawned("scout#1"));
		run.onEvent(closed("scout#1"));
		run.finish();

		const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as SubagentEvent);
		assert.deepEqual(events.map((one) => one.type), ["spawn", "close"]);
	});

	test("copies the parent session in when it is named, and claims no export at all when it is not", () => {
		const dir = tmpDir();
		const main = path.join(dir, "parent.jsonl");
		fs.writeFileSync(main, '{"type":"session"}\n');

		measuredRun({ dir, mainSessionFile: main }).finish();
		assert.ok(fs.existsSync(path.join(dir, "main.jsonl")));

		const bare = tmpDir();
		measuredRun({ dir: bare }).finish();
		assert.equal(report(bare).exports, undefined, "an empty promise about the parent session is worse than none");
	});

	test("a report that cannot be written is not the run's problem", () => {
		const dir = tmpDir();
		fs.writeFileSync(path.join(dir, "file"), "");
		const run = measuredRun({ dir: path.join(dir, "file", "nested") });
		assert.equal(run.finish().total.subagents, 0);
	});
});
