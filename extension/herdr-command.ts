/**
 * `/herdr` - whether every subagent gets a split, for this session.
 *
 * A session preference rather than a per-call argument: the point is to stop
 * threading `openInHerdr` through every call while a workflow is being
 * debugged.
 */

import { createHerdrSend, detectHerdr, probeHerdr } from "../src/index.ts";
import type { CommandCtx, PiApi } from "./pi.ts";
import { watchEverything, watchEverythingIs } from "./run-ui.ts";

/** What `/herdr` needs from the world. Injected so a test answers as a server would. */
export type HerdrDeps = {
	/** Where we are. Defaults to reading the environment. */
	detect?: typeof detectHerdr;
	/** Asks herdr whether a pane would open. Defaults to the real socket. */
	probe?: typeof probeHerdr;
};

/** Registers `/herdr`. */
export default function registerHerdrCommand(pi: PiApi) {
	pi.registerCommand("herdr", {
		description: "Watch every subagent in its own herdr split (on | off)",
		handler: async (args, ctx: CommandCtx) => {
			await toggleHerdr(args, ctx);
		},
	});
}

/**
 * `/herdr on|off` - or nothing, to see where it stands.
 *
 * It is a session preference, not a per-call argument: the point is to stop
 * threading `openInHerdr` through every call while debugging a workflow.
 *
 * Turning it on **asks herdr**, and says what it answered. Being inside herdr
 * was the only question this used to ask, and a herdr that refuses every
 * request looks identical from here: the reporter drops the pane without a
 * word, because display is an observer. The command is not, so this is where
 * the refusal gets said. The preference is still set either way - what a user
 * wants for the session is not herdr's to decide.
 */
export async function toggleHerdr(args: string, ctx: CommandCtx, deps: HerdrDeps = {}): Promise<boolean> {
	const word = args.trim().toLowerCase();
	const on = word === "on" || word === "all" ? true : word === "off" ? false : watchEverything();

	if (word && word !== "on" && word !== "off" && word !== "all") {
		ctx.ui.notify(`herdr: say on or off (currently ${watchEverything() ? "on" : "off"})`, "warning");
		return watchEverything();
	}

	watchEverythingIs(on);
	if (!on) {
		ctx.ui.notify("herdr: only the subagents that ask for a split get one", "info");
		return on;
	}

	const refusal = await whyNoSplit(ctx, deps);
	ctx.ui.notify(
		refusal ? `herdr: on, but ${refusal} - nothing will open` : "herdr: every subagent gets its own split",
		refusal ? "warning" : "info",
	);
	return on;
}

/** Why a split would not open, or `undefined` when one would. */
async function whyNoSplit(ctx: CommandCtx, deps: HerdrDeps): Promise<string | undefined> {
	const env = (deps.detect ?? detectHerdr)();
	if (!env) return "pi is not running inside herdr";

	// Worth the wait of one round-trip: the answer decides whether the next
	// half hour is spent watching panes or wondering where they are.
	ctx.ui.setStatus(HERDR_STATUS, "asking herdr…");
	try {
		return await (deps.probe ?? probeHerdr)(createHerdrSend(env));
	} finally {
		ctx.ui.setStatus(HERDR_STATUS, undefined);
	}
}

/** Key for the footer line while herdr is being asked. */
const HERDR_STATUS = "combo-herdr";
