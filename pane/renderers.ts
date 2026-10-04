/**
 * pi's own drawing for pi's own tools, named rather than guessed.
 *
 * `ToolExecutionComponent` handed no definition draws a generic box of
 * `key=value` arguments: pi's interactive mode finds its own tools' renderers
 * by name, but does not export that lookup. Naming the definitions is what
 * draws `grep /x/ in a.ts` in the pane, as pi does in the session.
 */

import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const DEFINITIONS = {
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	find: createFindToolDefinition,
	grep: createGrepToolDefinition,
	ls: createLsToolDefinition,
	powershell: createPowerShellToolDefinition,
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
} as const;

/** How pi draws `name`, or nothing for a tool that is not one of pi's. */
export function toolDefinition(name: string, cwd: string) {
	return DEFINITIONS[name as keyof typeof DEFINITIONS]?.(cwd);
}
