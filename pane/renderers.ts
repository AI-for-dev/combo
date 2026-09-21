/**
 * pi's own drawing for pi's own tools, named rather than guessed.
 *
 * `ToolExecutionComponent` draws a generic box of arguments when it is handed
 * no definition. Through 0.80 that fallback still recognised the built-in tools
 * by name and drew `grep /x/ in a.ts`; 0.86 draws the JSON. Naming the
 * definitions is what brings the line back, and what stops the pane depending
 * on a fallback that already moved once.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const DEFINITIONS = {
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	find: createFindToolDefinition,
	grep: createGrepToolDefinition,
	ls: createLsToolDefinition,
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
} as const;

/** How pi draws `name`, or nothing for a tool that is not one of pi's. */
export function toolDefinition(name: string, cwd: string) {
	return DEFINITIONS[name as keyof typeof DEFINITIONS]?.(cwd);
}
