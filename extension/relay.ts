/**
 * The relay: the chain somebody is walking by hand.
 *
 * A pipeline is a chain our code walks. This is the same chain with the user
 * as the runner: one step per command, and between two of them a human reads
 * the output, changes their mind, picks the next agent and the model it runs
 * on. What was missing for that is exactly one thing - somewhere to keep the
 * output of step *n* so step *n+1* can be handed it. That is this file.
 *
 * It keeps the material, and nothing else: no spawning, no pi, no terminal. The
 * commands in `step-commands.ts` do those. The split is what lets the whole
 * dataflow of a hand-walked chain be asserted on without a session.
 *
 * **The carried output never reaches the main session's context.** That is the
 * point of the relay rather than the conversation: the window stays a console,
 * and what the model gets to read is what `/quote` puts there on purpose.
 */

import { plural, stepInput, truncate, type Usage } from "../src/index.ts";

/** One step that ran: what it was asked, and what came back. */
export type RelayStep = {
	/** Unique within the chain, so `--from` can name it. `coder`, then `coder-2`. */
	id: string;
	/** The pipeline or agent that ran it, as it was named on the command line. */
	name: string;
	/** Which of the two it turned out to be. */
	kind: "agent" | "pipeline";
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
 * Appends a finished step, giving it an id nothing else in the chain has.
 *
 * Only successful steps get here: a step that failed produced nothing to carry,
 * and recording it would make `--from last` hand the next agent an error
 * message. The chain is left exactly where it was, which is also what lets the
 * same command be retried on another model.
 */
export function recordStep(relay: Relay, step: Omit<RelayStep, "id">): RelayStep {
	const recorded = { ...step, id: stepId(relay, step.name) };
	relay.steps.push(recorded);
	return recorded;
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
 * What the step is actually asked, in the sections a pipeline uses.
 *
 * `stepInput` and not a second framing of our own: a hand-walked chain and the
 * same chain written down as a pipeline then send the model byte-for-byte the
 * same thing, which is the only way the two can be compared. A first step
 * carries nothing and is passed through verbatim, exactly as `/run` passes its
 * request - a lone instruction under a `## Request` heading is noise.
 */
export function chainInput(instruction: string, previous?: RelayStep): string {
	return previous ? stepInput("", instruction, previous) : instruction.trim();
}

/** Every step's usage, summed. `wallMs` is deliberately absent: see {@link chainLines}. */
export function chainUsage(relay: Relay): Usage {
	return relay.steps.reduce(
		(total, step) => ({
			wallMs: total.wallMs + step.usage.wallMs,
			busyMs: total.busyMs + step.usage.busyMs,
			turns: total.turns + step.usage.turns,
			input: total.input + step.usage.input,
			output: total.output + step.usage.output,
			cacheRead: total.cacheRead + step.usage.cacheRead,
			cacheWrite: total.cacheWrite + step.usage.cacheWrite,
			cost: total.cost + step.usage.cost,
		}),
		{ wallMs: 0, busyMs: 0, turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
}

/**
 * `/chain`, as lines - the chain so far, and where it went.
 *
 * Kept away from the terminal so it can be asserted on directly, the same split
 * as `/pipelines` and `/agents`. The wall time shown is the sum of the steps'
 * own, not the age of the chain: a chain walked by hand spends most of its life
 * waiting for a human, and counting that as work would be an estimate.
 */
export function chainLines(relay: Relay | undefined): string[] {
	if (!relay || relay.steps.length === 0) {
		return ["No chain yet. /step <agent|pipeline> <what it should do> starts one."];
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
 * A step, framed for the conversation - what `/quote` sends.
 *
 * pi hands custom messages to the model as **user** messages, and an
 * unattributed report arriving in that slot reads as an instruction. Naming the
 * step and what it was asked turns it back into what it is: a result somebody
 * chose to show.
 */
export function stepAnswer(step: RelayStep): string {
	const asked = step.instruction.trim() ? `, asked to: ${step.instruction.trim()}` : "";
	return `Result of the \`${step.id}\` step of the chain${asked}.\n\n${step.output.trim()}`;
}
