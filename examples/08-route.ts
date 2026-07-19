/**
 * Routing: a classifier picks who does the work.
 *
 *   node examples/08-route.ts
 *
 * Two tasks, one router, the same two destinations. What to check: the router
 * sends the "where is it" question to the scout and the "review this" one to
 * the reviewer - and that it read nothing but the agents' `description` fields
 * to decide.
 *
 * Routing needs no second vocabulary: an agent's description is already
 * mandatory, and it is what the classifier reads. Vague descriptions produce
 * vague routing, and no parser can repair that.
 */

import { route } from "../src/index.ts";
import { agent, consoleReporter, repoRoot, show } from "./shared.ts";

const destinations = [agent("scout"), agent("reviewer")];

for (const task of [
	"Where is the lifetime of a subagent decided? Answer in two lines.",
	"Read src/result.ts and give at most two remarks on it.",
]) {
	const result = await route({
		router: agent("router"),
		destinations,
		input: task,
		cwd: repoRoot,
		onEvent: consoleReporter(),
	});

	show(
		`${result.destination?.name ?? "unrouted"} ← ${task.slice(0, 40)}…`,
		result.ok ? result.output : (result.error ?? "unknown"),
	);
}
