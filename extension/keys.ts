/**
 * The keys a live run listens to, and where a user rebinds them.
 *
 * Each has an id under `combo.`, and a user rebinds it in pi's own
 * `keybindings.json`, beside pi's ids and in pi's syntax:
 *
 *     { "combo.subagent.next": "alt+j", "combo.subagent.stop": [] }
 *
 * **This relies on undocumented behaviour of pi, observed on 1.0.2.** pi gives
 * an extension no way to declare a keybinding, so the manager pi-tui's
 * `getKeybindings()` returns knows nothing of these ids and `getKeys()` answers
 * `[]` for them. What it does do is keep every entry of the file in
 * `getUserBindings()`, ids it does not know included, and `/reload` re-reads
 * the file into the same manager. This file reads that, at each key and each
 * paint, and nothing else in the extension touches pi's keybindings.
 *
 * When pi lets an extension declare keybinding definitions (point c of the
 * issue drafted in `docs/decisions.md`, "Selecting a subagent with
 * shift+↑↓"), declare these ids there, read them with `getKeys()`, and this
 * file is down to its defaults.
 *
 * Whatever goes wrong while reading - no manager, no `getUserBindings`, a value
 * that is neither a key nor a list of keys - the id keeps its default, and says
 * nothing: a typo in a file must not cost anyone the key that stops a run.
 */

import { getKeybindings, isKeyRelease, matchesKey, type KeyId } from "@earendil-works/pi-tui";

/**
 * Each key's id, and what it is bound to when the user says nothing.
 *
 * `shift+↑↓` select because they are bound to nothing in pi, in either TUI
 * mode, editor included. `ctrl+↑↓` are pi's in fullscreen: its transcript
 * jumps between prompts, and its listener runs before any extension's.
 */
export const DEFAULT_KEYS = {
	"combo.run.stop": "escape",
	"combo.subagent.previous": "shift+up",
	"combo.subagent.next": "shift+down",
	"combo.subagent.stop": "ctrl+delete",
} as const;

/** One of combo's keys. */
export type ComboKey = keyof typeof DEFAULT_KEYS;

/** The keys `id` is bound to now: the user's, else its default. An empty list unbinds it, as it does for pi's own ids. */
export function keysOf(id: ComboKey): string[] {
	const bound = userBinding(id);
	if (typeof bound === "string" && bound !== "") return [bound];
	if (Array.isArray(bound) && bound.every((key) => typeof key === "string" && key !== "")) return bound;
	return [DEFAULT_KEYS[id]];
}

/** Whether `data` from the terminal is a press of `id`. A release is not: a press and its release would act twice. */
export function pressed(data: string, id: ComboKey): boolean {
	return !isKeyRelease(data) && keysOf(id).some((key) => matchesKey(data, key as KeyId));
}

/** `id`'s keys as pi shows a key in its own hints, or `""` when it is unbound. */
export function showKeys(id: ComboKey): string {
	return keysOf(id).map(showKey).join("/");
}

/** One key the way pi's `formatKeyText` writes it, which pi does not export: `alt` reads `option` on a Mac. */
function showKey(key: string): string {
	return key
		.split("+")
		.map((part) => (process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part))
		.join("+");
}

function userBinding(id: ComboKey): unknown {
	try {
		return getKeybindings().getUserBindings?.()[id];
	} catch {
		return undefined;
	}
}
