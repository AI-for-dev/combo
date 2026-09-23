/**
 * The person's side of a real run's `ask` nodes: the `ask` port, one card at
 * a time.
 *
 * Questions asked at once, by branches running together, queue in the order
 * they arrive: a person answers one card, and a second drawn over it would
 * take the keys the first is reading. Only the asking branch waits; the
 * others go on. A node's `timeout:` starts when its card is shown, as an
 * agent turn's starts when its subagent is free: a card waiting its turn is
 * not a person failing to answer.
 */

import type { AskUser } from "../../ask.ts";
import { outputOf, type AskingRun } from "./ask.ts";

/** The run's `ask`, through `port`; with none, nobody is there and every question is missed at once. */
export function personAsks(port: AskUser | undefined): AskingRun["ask"] {
	let queue: Promise<unknown> = Promise.resolve();
	return (node, _path, card, cut) => {
		if (port === undefined) return Promise.resolve({ missed: "nobody" });
		const shown = queue.then(async () => {
			if (cut.aborted) return { declined: true } as const;
			const deadline = node.timeoutMs === undefined ? undefined : AbortSignal.timeout(node.timeoutMs);
			const signal = deadline === undefined ? cut : AbortSignal.any([cut, deadline]);
			const answer = await untilAborted(port(card.question, { ...card.asking, signal }), signal);
			if (deadline?.aborted) return { missed: "timeout" } as const;
			return answer === undefined ? ({ declined: true } as const) : { output: outputOf(node, answer) };
		});
		queue = shown.catch(() => undefined);
		return shown;
	};
}

/** What `promise` gives, or `undefined` as soon as `signal` aborts: a card taken down is not waited for. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
