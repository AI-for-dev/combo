/**
 * `/chain export`: the page a chain leaves beside its folders.
 *
 * pi's `/export` draws none of a chain, so this page is the one place a whole
 * chain reads in order. What is asserted is what makes it readable: the steps
 * in the order they ran, each with what it was asked, what it answered and
 * where its transcripts are, and no answer able to break the page's outline.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { CHAIN_FILE, chainPage, writeChain } from "../extension/chain-export.ts";
import { forgetChain, recordStep, startChain, type Relay } from "../extension/relay.ts";
import { emptyUsage } from "../src/usage.ts";

const runs = mkdtempSync(join(tmpdir(), "combo-chain-export-"));
after(() => rmSync(runs, { recursive: true, force: true }));
beforeEach(forgetChain);

/** A chain of `scout` then `planner`, the second carrying the first, exporting under `dir`. */
function walked(dir: string, output = "Use three steps."): Relay {
	const relay = startChain(dir);
	recordStep(relay, { id: "scout", name: "scout", kind: "agent", instruction: "where is usage measured", output: "In src/usage.ts.", usage: { ...emptyUsage(), turns: 2 }, dir: join(dir, "1-scout") });
	recordStep(relay, { id: "planner", name: "planner", kind: "agent", instruction: "", from: "scout", output, usage: { ...emptyUsage(), turns: 1 }, dir: join(dir, "2-planner") });
	return relay;
}

describe("the chain page", () => {
	test("reads the steps in order: what each was asked, carried and answered, and its folder", () => {
		const page = chainPage(walked("runs/c"), () => []);

		assert.match(page, /scout → planner/);
		assert.match(page, /3 turns/, "the chain's total");
		assert.ok(page.indexOf("## 1. scout") < page.indexOf("## 2. planner"));
		assert.match(page, /```\nwhere is usage measured\n```/);
		assert.match(page, /agent `planner`, carrying `scout`/);
		assert.match(page, /Folder: \[2-planner\/\]\(2-planner\/\)/);
	});

	test("a step asked nothing beyond what it carried has no empty request", () => {
		const page = chainPage(walked("runs/c"), () => []);
		const planner = page.slice(page.indexOf("## 2. planner"));
		assert.ok(!planner.includes("### Request"));
	});

	test("an answer holding a fence or a heading stays inside its own", () => {
		const page = chainPage(walked("runs/c", "## Plan\n\n```ts\nx\n```"), () => []);
		assert.match(page, /````\n## Plan\n\n```ts\nx\n```\n````/);
	});
});

describe("writeChain", () => {
	test("writes the page into the chain's folder, linking every transcript but the session files", () => {
		const dir = mkdtempSync(join(runs, "chain-"));
		const relay = walked(dir);
		mkdirSync(join(dir, "1-scout", ".sessions"), { recursive: true });
		mkdirSync(join(dir, "2-planner", "planner.children"), { recursive: true });
		writeFileSync(join(dir, "1-scout", "scout.html"), "");
		writeFileSync(join(dir, "1-scout", ".sessions", "raw.html"), "");
		writeFileSync(join(dir, "2-planner", "planner.children", "scout#1.html"), "");

		const file = writeChain(relay);
		const page = readFileSync(file, "utf8");

		assert.equal(file, join(dir, CHAIN_FILE));
		assert.match(page, /\[1-scout\/scout\.html\]\(1-scout\/scout\.html\)/);
		assert.match(page, /\[2-planner\/planner\.children\/scout#1\.html\]\(2-planner\/planner\.children\/scout%231\.html\)/);
		assert.ok(!page.includes(".sessions"));
	});
});
