/**
 * The TUI class, whichever pi-tui the pane was installed beside.
 *
 * `TUI` was the concrete class through 0.80.x. 0.86 made it the interface and
 * split the implementation in two: `TuiMainScreen` draws inline, where `TUI`
 * drew, and `TuiAltScreen` takes the whole terminal. The pane draws inline,
 * like a pi session does.
 *
 * Chosen by the presence of the export and never by a version string, for the
 * same reason `buildRegistry` chooses that way: the pi that matters is the one
 * this was installed beside, and its version is not ours to predict.
 */

import * as tui from "@earendil-works/pi-tui";
import type { Terminal, TUI } from "@earendil-works/pi-tui";

/** A TUI drawing inline, on whichever pi-tui is present. */
export function createTui(terminal: Terminal): TUI {
	const exported = tui as unknown as Record<string, unknown>;
	const cls = exported.TuiMainScreen ?? exported.TUI;
	if (typeof cls !== "function") {
		throw new Error("Unsupported pi-tui: neither TuiMainScreen nor TUI is exported.");
	}
	return new (cls as new (terminal: Terminal) => TUI)(terminal);
}
