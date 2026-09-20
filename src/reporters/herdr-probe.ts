/**
 * Asking herdr whether it would open a pane, without opening one.
 *
 * `/herdr on` used to answer one question - are we inside herdr - and that was
 * the wrong one. A herdr that is there and refuses every request looks exactly
 * like a herdr that is there and works: the reporter drops a pane it cannot
 * open, silently, because display is an observer and an observer that warns is
 * a participant. `agent.start` changed shape between protocols and nothing said
 * a word for two releases.
 *
 * So the command asks, and the trick is the pane it names. Sent with a
 * `target_pane_id` that cannot exist, `pane.split` separates the two answers
 * herdr gives: `invalid_request` when the request itself is wrong, and
 * `pane_not_found` when the request was understood and only that pane was
 * missing. The second is the one we are fishing for, and neither opens
 * anything.
 *
 * It probes `pane.split` alone, because nothing else runs without the pane id
 * it returns. `scripts/check-herdr.ts` is what covers the other five, against
 * the schema rather than against a live server.
 */

import { errorOf, paneIdOf, type HerdrSend } from "./herdr-client.ts";
import { splitParams } from "./herdr.ts";

/** A pane herdr cannot have. Prefixed so a human reading a log knows who asked. */
const NO_SUCH_PANE = "combo:probe";

/**
 * Why a pane would not open, or `undefined` when one would.
 *
 * Never throws: a broken probe must not be worse than no probe.
 */
export async function probeHerdr(send: HerdrSend): Promise<string | undefined> {
	let answer: unknown;
	try {
		answer = await send("pane.split", { ...splitParams({}), target_pane_id: NO_SUCH_PANE });
	} catch (cause) {
		return cause instanceof Error ? cause.message : String(cause);
	}

	// herdr split something anyway: the trick has stopped working, panes have
	// not, and leaving it open would be a worse answer than a wrong one.
	const opened = paneIdOf(answer);
	if (opened) {
		await send("pane.close", { pane_id: opened }).catch(() => undefined);
		return undefined;
	}

	const error = errorOf(answer);
	if (!error) return "herdr is not answering";
	return error.code === "pane_not_found" ? undefined : `herdr refused pane.split: ${error.message}`;
}
