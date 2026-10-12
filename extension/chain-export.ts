/**
 * `/chain export`: the chain as one page, written beside the folders it ran in.
 *
 * pi's own `/export` shows none of a chain. A step is a `custom` entry, which
 * pi keeps out of the model's context and out of its HTML export alike, and
 * `/export` is built into pi with no event an extension can hook. The steps
 * are on disk already, one folder each, and this page reads them in order:
 * what each was asked, what it answered, and where its transcripts are.
 *
 * Markdown, because what a step answers is Markdown. Requests and outputs go
 * in fences, so a heading inside an answer cannot break the page's outline.
 */

import fs from "node:fs";
import path from "node:path";
import { formatUsage } from "../src/index.ts";
import { chainUsage, type Relay, type RelayStep } from "./relay.ts";

/** The page's name in the chain's folder. */
export const CHAIN_FILE = "chain.md";

/** Writes {@link chainPage} into the chain's folder, replacing an older one, and returns its path. */
export function writeChain(relay: Relay): string {
	const file = path.join(relay.dir, CHAIN_FILE);
	fs.writeFileSync(file, chainPage(relay, (step) => transcriptsOf(relay.dir, step)));
	return file;
}

/**
 * The page for a chain. `transcripts` lists a step's HTML transcripts, relative
 * to the chain's folder: injected, so the page can be checked without a disk.
 */
export function chainPage(relay: Relay, transcripts: (step: RelayStep) => string[]): string {
	const lines = [`# Chain`, "", `${relay.steps.map((step) => step.id).join(" → ")}`, "", formatUsage(chainUsage(relay))];
	relay.steps.forEach((step, index) => {
		const folder = link(`${path.relative(relay.dir, step.dir)}/`);
		lines.push("", `## ${index + 1}. ${step.id}`, "", `${step.kind} \`${step.name}\`${step.from ? `, carrying \`${step.from}\`` : ""} - ${formatUsage(step.usage)}`);
		lines.push("", `Folder: ${folder}`);
		const pages = transcripts(step);
		if (pages.length > 0) lines.push("", `Transcripts: ${pages.map(link).join(", ")}`);
		if (step.instruction.trim()) lines.push("", "### Request", "", fenced(step.instruction.trim()));
		lines.push("", "### Output", "", fenced(step.output.trim()));
	});
	return `${lines.join("\n")}\n`;
}

/**
 * Every `.html` under a step's folder, a flow's nested homes and a delegated
 * child's `.children/` included. The session files behind them are not for
 * reading, and stay out.
 */
function transcriptsOf(root: string, step: RelayStep): string[] {
	if (!fs.existsSync(step.dir)) return [];
	return fs
		.readdirSync(step.dir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".html") && !name.split(path.sep).includes(".sessions"))
		.map((name) => path.relative(root, path.join(step.dir, name)))
		.sort();
}

/**
 * A relative path as a link, its text the path itself. Each segment is encoded
 * on its own, because a delegated child's transcript is named after its id and
 * `reviewer#2` read whole as a URL is a fragment.
 */
function link(target: string): string {
	const segments = target.split(path.sep);
	return `[${segments.join("/")}](${segments.map(encodeURIComponent).join("/")})`;
}

/** A fence longer than any run of backticks inside, so nothing in `text` can close it. */
function fenced(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${text}\n${fence}`;
}
