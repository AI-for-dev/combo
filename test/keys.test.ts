import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { keysOf, pressed, showKeys } from "../extension/keys.ts";

/** pi's manager as `keybindings.json` would fill it: unknown ids are kept in the user bindings. */
function userBindings(bindings: Record<string, unknown>) {
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, bindings as never));
}

afterEach(() => setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)));

const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";

describe("combo's keys", () => {
	test("default to shift+↑↓, ctrl+delete and escape", () => {
		assert.deepEqual(keysOf("combo.subagent.previous"), ["shift+up"]);
		assert.deepEqual(keysOf("combo.subagent.next"), ["shift+down"]);
		assert.deepEqual(keysOf("combo.subagent.stop"), ["ctrl+delete"]);
		assert.deepEqual(keysOf("combo.run.stop"), ["escape"]);
		assert.equal(pressed(SHIFT_DOWN, "combo.subagent.next"), true);
		assert.equal(pressed("\x1b[1;5B", "combo.subagent.next"), false, "ctrl+↓ is pi's in fullscreen");
	});

	test("follow an override in pi's keybindings.json, read at the moment they are asked for", () => {
		userBindings({ "combo.subagent.next": ["alt+j", "shift+down"] });

		assert.deepEqual(keysOf("combo.subagent.next"), ["alt+j", "shift+down"]);
		assert.equal(pressed("\x1bj", "combo.subagent.next"), true);
		assert.equal(showKeys("combo.subagent.next"), "alt+j/shift+down", "several keys are shown the way pi shows them");
		assert.deepEqual(keysOf("combo.subagent.previous"), ["shift+up"], "an id left out keeps its default");
	});

	test("an empty list unbinds a key, as it does for pi's own ids", () => {
		userBindings({ "combo.subagent.stop": [] });

		assert.deepEqual(keysOf("combo.subagent.stop"), []);
		assert.equal(showKeys("combo.subagent.stop"), "");
		assert.equal(pressed("\x1b[3;5~", "combo.subagent.stop"), false);
	});

	test("fall back to their default on a value that is not a key", () => {
		for (const value of [42, "", null, { key: "x" }, ["shift+up", 7], [""]]) {
			userBindings({ "combo.run.stop": value });
			assert.deepEqual(keysOf("combo.run.stop"), ["escape"], `${JSON.stringify(value)} must not cost anyone the stop key`);
		}
	});

	test("fall back to their default when pi's manager does not have what they read", () => {
		setKeybindings({} as KeybindingsManager);
		assert.deepEqual(keysOf("combo.subagent.next"), ["shift+down"]);

		setKeybindings({
			getUserBindings() {
				throw new Error("pi changed shape");
			},
		} as unknown as KeybindingsManager);
		assert.deepEqual(keysOf("combo.subagent.next"), ["shift+down"]);
		assert.equal(pressed(SHIFT_UP, "combo.subagent.previous"), true);
	});

	test("are not pressed by the release a terminal reports after the press", () => {
		assert.equal(pressed("\x1b[1;2:1B", "combo.subagent.next"), true);
		assert.equal(pressed("\x1b[1;2:3B", "combo.subagent.next"), false, "a press and its release would move the selection twice");
	});
});
