/**
 * The agents and flows this package ships with.
 *
 * They are the lowest-priority source, always: a definition of the same name in
 * `~/.pi/agent/` or in the repository **replaces** one of these. Shipping a
 * `scout` must make the tool usable out of the box, never take the name away
 * from somebody who wants their own.
 *
 * This reverses a rule that stood for one commit ("an extension never brings its
 * own agents"). The argument that overturned it: loading an extension already
 * runs its code - pi's own documentation says so plainly - so reading Markdown
 * from the same directory adds no risk that installing it did not already
 * accept. What the old rule was really protecting against is *silently losing
 * control of a name*, and precedence protects that directly.
 *
 * Resolved from this module's own location rather than from `process.cwd()`: an
 * extension is loaded into pi's process, and the working directory is the
 * user's repository, not ours.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * Root of the installed package: the nearest directory above this module that
 * holds a `package.json`. Searched rather than counted, because this module
 * runs as `src/builtin.ts` from a clone and as `dist/src/builtin.js` once
 * published, one level deeper.
 */
export const PACKAGE_ROOT = packageRoot(path.dirname(fileURLToPath(import.meta.url)));

function packageRoot(dir: string): string {
	if (fs.existsSync(path.join(dir, "package.json"))) return dir;
	const parent = path.dirname(dir);
	if (parent === dir) throw new Error(`no package.json above ${dir}`);
	return packageRoot(parent);
}

/** The agent definitions shipped here. Lowest priority of the three sources. */
export const BUILTIN_AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");

/** The flows shipped here. Lowest priority of the three sources. */
export const BUILTIN_FLOWS_DIR = path.join(PACKAGE_ROOT, "flows");
