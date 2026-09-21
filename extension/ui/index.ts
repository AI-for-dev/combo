/**
 * What touches the terminal without registering anything: the live view of a
 * run, the question card, and the two switches a card and a key share.
 *
 * This is the directory's door. The floor's `command.ts` stands on `liveRun`,
 * the commands read the switches, and nothing here knows a command by name.
 */

export { createAskUi } from "./ask.ts";
export { isAsking, whileAsking } from "./asking.ts";
export { watchEverything, watchEverythingIs } from "./herdr-switch.ts";
export { liveRun, STATUS, type LiveRun, type LiveRunOptions } from "./run.ts";
