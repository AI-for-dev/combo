/**
 * A pane on one subagent: the process a herdr split runs.
 *
 *   node pane/main.ts --socket <mirror socket> --id scout#1
 *
 * It attaches to the mirror, draws the session with pi's own components, and
 * sends the keyboard back. The theme is the user's, read the way pi reads it:
 * the pane is the user's window, not the subagent's environment.
 */

import { getAgentDir, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, TUI } from "@earendil-works/pi-tui";
import { attachTo } from "./client.ts";
import { createScreen, type Screen } from "./screen.ts";

const args = process.argv.slice(2);
const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const socket = valueOf("--socket");
const id = valueOf("--id");
if (!socket || !id) {
	console.error("usage: node pane/main.ts --socket <path> --id <subagent id>");
	process.exit(2);
}

const cwd = process.cwd();
try {
	initTheme(SettingsManager.create(cwd, getAgentDir()).getTheme());
} catch {
	initTheme();
}

const ui = new TUI(new ProcessTerminal());
let screen: Screen | undefined;

const leave = () => {
	client.close();
	ui.stop();
	process.exit(0);
};

const client = attachTo({
	socket,
	id,
	onLine: (line) => screen?.handle(line),
	onEnd: (reason) => screen?.disconnected(reason),
});

screen = createScreen(ui, id, cwd, {
	steer: (text) => client.send({ type: "steer", text }),
	abort: () => client.send({ type: "abort" }),
	leave,
});

ui.start();
