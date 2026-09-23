/**
 * Reading an `ask` node: a question put to a person, in the form its keys
 * choose, and what nobody answering gives.
 *
 * Every text is kept as written. The runner rewrites none of it, so a
 * literal card reads in the language of the file; a card in the person's
 * language is an agent node writing a `Question` that `ask-from:` reads.
 */

import type { Choice } from "../ask.ts";
import type { FaultList } from "./fault.ts";
import type { AskForm, AskNode, NodeReading } from "./node.ts";
import { isRecord } from "./read-node.ts";
import { duration, text, texts } from "./value.ts";

/** How many options a literal card offers: a choice between one is no choice, and more than four is not read. */
const OPTIONS = { least: 2, most: 4 };

/** An `ask` node, or `undefined` when a fault refused it. */
export function readAsk({ raw, id, at, faults, continueOnFail }: NodeReading): AskNode | undefined {
	const key = (name: string) => `${at}.${name}`;
	const before = faults.list.length;
	const from = raw["ask-from"] !== undefined;
	const written = from ? text(raw["ask-from"], key("ask-from"), faults) : text(raw.ask, key("ask"), faults);
	if (raw.confirm !== undefined && raw.confirm !== true) faults.add("key-type", key("confirm"), "takes `true`; a free text is an `ask` with neither `confirm:` nor `options:`");
	const form: AskForm = from || raw.options !== undefined ? "choice" : raw.confirm === true ? "confirm" : "text";
	for (const [name, why] of conflicts(raw, from, form)) faults.add("ask-form-conflict", key(name), why);
	const options = raw.options === undefined || from ? undefined : readOptions(raw.options, key("options"), faults);
	const node = {
		kind: "ask",
		id,
		at,
		continueOnFail,
		form,
		options,
		enough: raw.enough === undefined ? undefined : text(raw.enough, key("enough"), faults),
		default: raw.default === undefined ? undefined : readDefault(raw.default, form, options, key("default"), faults),
		reads: (raw.reads === undefined ? [] : texts(raw.reads, key("reads"), faults)) ?? [],
		timeoutMs: raw.timeout === undefined ? undefined : duration(raw.timeout, key("timeout"), faults),
	} as const;
	if (written === undefined || faults.list.length > before) return undefined;
	return { ...node, question: from ? { from: written } : { text: written } };
}

/** The keys written beside each other that the form does not take together, each with why. */
function conflicts(raw: Readonly<Record<string, unknown>>, from: boolean, form: AskForm): [string, string][] {
	const found: [string, string][] = [];
	if (from && raw.options !== undefined) found.push(["options", "`ask-from:` reads a `Question`, which carries its own options"]);
	if (raw.confirm !== undefined && (from || raw.options !== undefined)) {
		found.push(["confirm", from ? "`ask-from:` reads a `Question`, a choice card: a yes or no is written `ask:`" : "a card is a choice between `options:` or a yes or no, not both"]);
	}
	if (raw.enough !== undefined && form !== "choice") found.push(["enough", "`enough:` offers \"that's enough\" on a choice card; a yes or no, or a free text, is always answered"]);
	return found;
}

/** Literal options: labels, or `{ label, description? }`, between two and four, no label twice. */
function readOptions(value: unknown, at: string, faults: FaultList): Choice[] | undefined {
	if (!Array.isArray(value)) {
		faults.add("key-type", at, "takes a list of labels, or of `{ label, description? }`");
		return undefined;
	}
	const choices = value.map((one, index) => readChoice(one, `${at}[${index}]`, faults));
	if (choices.some((one) => one === undefined)) return undefined;
	if (choices.length < OPTIONS.least || choices.length > OPTIONS.most) {
		faults.add("ask-options-count", at, `a card offers ${OPTIONS.least} to ${OPTIONS.most} options, and this one has ${choices.length}`);
		return undefined;
	}
	const labels = (choices as Choice[]).map((one) => one.label);
	const twice = labels.filter((label, i) => labels.indexOf(label) !== i);
	if (twice.length === 0) return choices as Choice[];
	faults.add("ask-options-duplicate", at, `${twice.map((label) => `\`${label}\``).join(", ")} is offered twice: a label is what a condition tells the options apart by`);
	return undefined;
}

function readChoice(value: unknown, at: string, faults: FaultList): Choice | undefined {
	if (typeof value === "string") {
		const label = text(value, at, faults);
		return label === undefined ? undefined : { label };
	}
	if (!isRecord(value)) {
		faults.add("key-type", at, "an option is a label, or `{ label, description? }`");
		return undefined;
	}
	const before = faults.list.length;
	faults.keys(value, ["label", "description"], at, "keys of an option");
	const label = text(value.label, `${at}.label`, faults);
	const description = value.description === undefined ? undefined : text(value.description, `${at}.description`, faults);
	if (label === undefined || faults.list.length > before) return undefined;
	return description === undefined ? { label } : { label, description };
}

/** `default:`, a literal of the node's own form: a label of its options, a text, or a yes or no. */
function readDefault(value: unknown, form: AskForm, options: readonly Choice[] | undefined, at: string, faults: FaultList): string | boolean | undefined {
	const off = (why: string) => {
		faults.add("ask-default-mismatch", at, why);
		return undefined;
	};
	if (form === "confirm") return typeof value === "boolean" ? value : off("a yes or no takes `default: true` or `default: false`");
	if (form === "text") return typeof value === "string" ? value : off("a free text takes a text as its default");
	if (typeof value !== "string" || value.trim() === "") return off("a choice card takes a label as its default");
	if (options === undefined || options.some((one) => one.label === value)) return value;
	return off(`\`${value}\` is not one of the options: ${options.map((one) => one.label).join(", ")}`);
}
