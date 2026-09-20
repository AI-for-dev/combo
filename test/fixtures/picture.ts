/**
 * Events and snapshots for testing the picture of a run and what is drawn from it.
 */

import type { SubagentEvent } from "../../src/events.ts";
import { createRunPicture, type RunPicture, type SubagentSnapshot } from "../../src/reporters/picture.ts";
import { emptyUsage, type Usage } from "../../src/usage.ts";

let launch = 0;

/** A `spawn`, numbered in the order this file asked for them. */
export const spawned = (id: string, parentId?: string, model?: string): SubagentEvent => ({
	type: "spawn",
	id,
	agent: id.split("#")[0] as string,
	order: ++launch,
	lifetime: "task",
	openInHerdr: false,
	parentId,
	model,
});

/** The `status` that carries the task: what the core emits when a turn starts. */
export const working = (id: string, task: string): SubagentEvent => ({ type: "status", id, status: "working", task });

export const closed = (id: string, ok = true, usage: Partial<Usage> = {}): SubagentEvent => ({
	type: "close",
	id,
	result: {
		agent: id.split("#")[0] as string,
		output: "",
		messages: [],
		ok,
		error: ok ? undefined : "it broke",
		usage: { ...emptyUsage(), ...usage },
	},
});

/** A snapshot built by hand, for the shapes no event stream can produce. */
export const blank = (id: string): SubagentSnapshot => ({
	id,
	agent: id.split("#")[0] as string,
	lifetime: "task",
	status: "idle",
	task: "",
	tools: [],
	output: "",
	usage: emptyUsage(),
	depth: 0,
});

/** Replays a sequence into a fresh picture. */
export function replay(...events: SubagentEvent[]): RunPicture {
	const picture = createRunPicture();
	for (const event of events) picture.reporter(event);
	return picture;
}
