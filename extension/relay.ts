/**
 * The relay: the chain somebody is walking by hand.
 *
 * A flow is a chain our code walks. This is a chain with the user as the
 * runner: one step per command, and between two of them a human reads
 * the output, changes their mind, picks the next agent and the model it runs
 * on. What was missing for that is exactly one thing - somewhere to keep the
 * output of step *n* so step *n+1* can be handed it. That is this file.
 *
 * It keeps the material, and owns the life of a step around it - begun before
 * anything runs, finished once it has - and nothing else: no spawning, no pi,
 * no terminal. The commands in `commands/step.ts` and `commands/swarm.ts` do
 * those. The split is what lets the whole dataflow of a hand-walked chain be
 * asserted on without a session.
 *
 * **The carried output never reaches the main session's context.** That is the
 * point of the relay rather than the conversation: the window stays a console,
 * and what the model gets to read is what `/quote` puts there on purpose.
 */

import * as path from "node:path";
import { exportBaseName, plural, sumUsage, truncate, type Usage } from "../src/index.ts";

/** What ran a step. An entry an older session wrote may say `pipeline`, and is drawn as it says. */
export type StepKind = "agent" | "flow" | "swarm";

/** One step that ran: what it was asked, and what came back. */
export type RelayStep = {
	/** Unique within the chain, so `--from` can name it. `coder`, then `coder-2`. */
	id: string;
	/** The flow or agent that ran it, as it was named on the command line. */
	name: string;
	/** What ran it: one agent, a flow, or several copies of one agent. */
	kind: StepKind;
	/** What the user typed for this step, without the output it carried in. */
	instruction: string;
	/** Which step's output it was handed, if any. */
	from?: string;
	/** What it produced - the material the next step may carry. */
	output: string;
	/** What it cost. Summed over the chain by {@link chainUsage}. */
	usage: Usage;
	/** Where this step's transcripts and `usage.json` landed. */
	dir: string;
};

/** A chain in progress: the steps that ran, and the folder they all export into. */
export type Relay = {
	/** In the order they ran. A failed step is not here - it produced no material. */
	steps: RelayStep[];
	/** `runs/<timestamp>/`, made once for the whole chain rather than per step. */
	dir: string;
};

/**
 * The chain being walked in this terminal.
 *
 * Module state, like `/herdr`'s switch and for the same reason: it is a fact
 * about this window, it has to survive from one command to the next, and there
 * is exactly one chain being walked at a time. Nothing ambient creates it - the
 * first `/step` does, and `/chain reset` drops it.
 */
let current: Relay | undefined;

/** The chain being walked, or `undefined` before the first step of one. */
export function currentChain(): Relay | undefined {
	return current;
}

/** Starts a chain exporting into `dir`, replacing whatever was being walked. */
export function startChain(dir: string): Relay {
	current = { steps: [], dir };
	return current;
}

/** Drops the chain. The next step starts a new one, in a new folder. */
export function forgetChain(): void {
	current = undefined;
}

/**
 * Appends a finished step under the id it ran with.
 *
 * Only successful steps get here: a step that failed produced nothing to carry,
 * and recording it would make `--from last` hand the next agent an error
 * message. The chain is left exactly where it was, which is also what lets the
 * same command be retried on another model.
 *
 * The id comes from {@link stepId}, taken before the step ran so that its
 * folder and its entry carry the same name. A second step under an id the
 * chain already holds is a programming error, and throws.
 */
export function recordStep(relay: Relay, step: RelayStep): RelayStep {
	if (relay.steps.some((one) => one.id === step.id)) throw new Error(`relay: a step called \`${step.id}\` is already in this chain`);
	relay.steps.push(step);
	return step;
}

/** `coder` while it is free, then `coder-2`: an id a user can type. */
export function stepId(relay: Relay, name: string): string {
	const taken = new Set(relay.steps.map((step) => step.id));
	if (!taken.has(name)) return name;
	for (let n = 2; ; n++) {
		const id = `${name}-${n}`;
		if (!taken.has(id)) return id;
	}
}

/**
 * Where the step about to run exports: `runs/<chain>/<n>-<id>/`.
 *
 * One chain, one folder, one step per numbered subfolder: a chain walked by
 * hand is still a run, and it leaves the same trace as one walked by `/run`.
 * Numbered by position so the folders read in the order the steps ran, and
 * named by id so the folder and the transcript entry say the same thing.
 */
export function stepDir(relay: Relay, id: string): string {
	return path.join(relay.dir, `${relay.steps.length + 1}-${exportBaseName(id)}`);
}

/** A step begun: the chain it runs in, the id it runs under, and where it exports. */
export type BegunStep = {
	relay: Relay;
	id: string;
	dir: string;
};

/**
 * Begins a step of the chain in this terminal.
 *
 * Continues the chain being walked, or starts one in a fresh folder, and names
 * the step and its export folder **before** anything runs, so the folder, the
 * record and the entry carry one name whatever happens in between.
 */
export function beginStep(name: string, runDir: () => string): BegunStep {
	const relay = currentChain() ?? startChain(runDir());
	const id = stepId(relay, name);
	return { relay, id, dir: stepDir(relay, id) };
}

/** What a finished step brings to the chain: everything it keeps but what {@link beginStep} named. */
export type StepOutcome = Omit<RelayStep, "id" | "dir">;

/**
 * Finishes a step: records it under the id it began with, and leaves its entry
 * in the transcript through the door it is handed.
 *
 * One call, because the two acts belong together. A step recorded and never
 * drawn is invisible to the person walking the chain; one drawn and never
 * recorded cannot be carried on. Two commands ended a stage by hand in eight
 * steps each, reading the door off their raw dependencies where a forgotten
 * one failed in silence.
 */
export function finishStep(begun: BegunStep, outcome: StepOutcome, appendEntry: AppendEntry): RelayStep {
	const step = recordStep(begun.relay, { ...outcome, id: begun.id, dir: begun.dir });
	appendEntry(STEP_ENTRY, entryOf(step));
	return step;
}

/** `customType` of the transcript entry a finished step leaves behind. */
export const STEP_ENTRY = "chain-step";

/** How a finished step reaches the transcript, and only the transcript. Injected, so a test can catch it. */
export type AppendEntry = (customType: string, data: StepEntry) => void;

/**
 * What {@link STEP_ENTRY} carries, and the renderer in `index.ts` draws.
 *
 * Less than a {@link RelayStep}: the entry is written into the session file, so
 * it holds what the transcript shows and not what the chain needs to carry on.
 */
export type StepEntry = {
	/** The step's id in the chain, which is also what `--from` takes. */
	id: string;
	/** What ran it: one agent, a flow, or a swarm of one agent's copies. */
	kind: StepKind;
	/** The step whose output it was handed, when it was handed one. */
	from?: string;
	/** What it produced, in full - this is a transcript entry, not a summary. */
	output: string;
	/** Turns, so the entry says what it cost without expanding anything. */
	turns: number;
	/** Where this step's transcripts landed. */
	dir: string;
};

/** The entry a recorded step leaves in the transcript. */
export function entryOf(step: RelayStep): StepEntry {
	return { id: step.id, kind: step.kind, from: step.from, output: step.output, turns: step.usage.turns, dir: step.dir };
}

/**
 * What `--from` names: a step id, `last` (the default), or `none`.
 *
 * Throws on a name nothing answers to, listing what the chain does hold -
 * a typo here costs a whole step of real work otherwise.
 */
export function stepFrom(relay: Relay | undefined, from: string | undefined): RelayStep | undefined {
	const wanted = from?.trim() || "last";
	if (wanted === "none") return undefined;
	if (!relay || relay.steps.length === 0) {
		if (wanted === "last") return undefined;
		throw new Error(`step: nothing has run yet, so there is no \`${wanted}\` to carry`);
	}

	if (wanted === "last") return relay.steps.at(-1);
	const found = relay.steps.find((step) => step.id === wanted);
	if (found) return found;
	throw new Error(`step: no step called \`${wanted}\` in this chain. It holds: ${relay.steps.map((step) => step.id).join(", ")}`);
}

/**
 * What the step is actually asked: the instruction under `## Request`, then
 * the output it carries under the step it came from. A first step carries
 * nothing and is passed through verbatim, exactly as `/run` passes its
 * request - a lone instruction under a heading is noise. Empty parts are
 * dropped rather than left as a heading with nothing under it.
 */
export function chainInput(instruction: string, previous?: RelayStep): string {
	if (!previous) return instruction.trim();
	const parts = [instruction.trim() && `## Request\n\n${instruction.trim()}`, previous.output.trim() && `## Output of step \`${previous.id}\`\n\n${previous.output.trim()}`];
	return parts.filter(Boolean).join("\n\n");
}

/**
 * Every step's usage, summed - `wallMs` included, as the sum of the steps' own.
 *
 * A chain walked by hand spends most of its life waiting for a human, and
 * counting that as work would be an estimate; the steps' wall times add up
 * because they ran one after another. See {@link chainLines}.
 */
export function chainUsage(relay: Relay): Usage {
	return sumUsage(
		relay.steps.map((step) => step.usage),
		relay.steps.reduce((sum, step) => sum + step.usage.wallMs, 0),
	);
}

/**
 * `/chain`, as lines - the chain so far, and where it went.
 *
 * Kept away from the terminal so it can be asserted on directly, the same split
 * as `/flows` and `/agents`. The wall time shown is the sum of the steps'
 * own, not the age of the chain: a chain walked by hand spends most of its life
 * waiting for a human, and counting that as work would be an estimate.
 */
export function chainLines(relay: Relay | undefined): string[] {
	if (!relay || relay.steps.length === 0) {
		return ["No chain yet. /step <flow|agent> <what it should do> starts one."];
	}

	const width = Math.max(...relay.steps.map((step) => step.id.length));
	const lines = relay.steps.map((step, index) => {
		const carried = step.from ? ` ←${step.from}` : "";
		const asked = step.instruction.trim() ? ` ${truncate(step.instruction, 40)}` : "";
		return `${index + 1}. ${step.id.padEnd(width)}  ${step.kind}${carried}${asked}  ${plural(step.usage.turns, "turn")}`;
	});

	const usage = chainUsage(relay);
	lines.push(`${plural(relay.steps.length, "step")}, ${plural(usage.turns, "turn")} - exported to ${relay.dir}`);
	return lines;
}

/**
 * A result, framed for the conversation.
 *
 * pi hands custom messages to the model as **user** messages, and an
 * unattributed report arriving in that slot reads as an instruction. Naming
 * what ran and what it was asked turns it back into what it is: a result
 * somebody chose to show. One framing for a step `/quote` sends and a flow
 * `/run` sends, so the two read alike.
 */
export function framed(what: string, asked: string, output: string): string {
	const about = asked.trim() ? `, asked to: ${asked.trim()}` : "";
	// A request ending on its own `?` or `.` is not given a second stop.
	const stop = /[.?!]$/.test(about) ? "" : ".";
	return `Result of ${what}${about}${stop}\n\n${output.trim()}`;
}

/** A step, framed for the conversation - what `/quote` sends. */
export function stepAnswer(step: RelayStep): string {
	return framed(`the \`${step.id}\` step of the chain`, step.instruction, step.output);
}
