/**
 * `/herdr` - whether every subagent gets a split, for this session.
 *
 * A session preference rather than a per-call argument: the point is to stop
 * threading `openInHerdr` through every call while a workflow is being
 * debugged.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { detectHerdr } from "../src/index.ts";
import type { CommandCtx } from "./command.ts";
import { watchEverything, watchEverythingIs } from "./run-ui.ts";

/** Registers `/herdr`. */
export default function registerHerdrCommand(pi: ExtensionAPI) {
	pi.registerCommand("herdr", {
		description: "Watch every subagent in its own herdr split (on | off)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			toggleHerdr(args, ctx as unknown as CommandCtx);
		},
	});
}

/**
 * `/herdr on|off` - or nothing, to see where it stands.
 *
 * It is a session preference, not a per-call argument: the point is to stop
 * threading `openInHerdr` through every call while debugging a workflow. Outside
 * herdr it still answers, and says plainly that nothing will open - silence
 * would read as a broken command.
 */
export function toggleHerdr(args: string, ctx: CommandCtx): boolean {
	const word = args.trim().toLowerCase();
	const on = word === "on" || word === "all" ? true : word === "off" ? false : watchEverything();

	if (word && word !== "on" && word !== "off" && word !== "all") {
		ctx.ui.notify(`herdr: say on or off (currently ${watchEverything() ? "on" : "off"})`, "warning");
		return watchEverything();
	}

	watchEverythingIs(on);
	const inside = detectHerdr() !== undefined;
	ctx.ui.notify(
		on
			? inside
				? "herdr: every subagent gets its own split"
				: "herdr: on, but pi is not running inside herdr - nothing will open"
			: "herdr: only the subagents that ask for a split get one",
		on && !inside ? "warning" : "info",
	);
	return on;
}
