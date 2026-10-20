/**
 * Starts the pane client: the process a herdr split runs.
 *
 *   node pane/launch.mjs --socket <mirror socket> --id scout#1
 *
 * Plain JavaScript on purpose. `pi install` puts this package under
 * node_modules, where node refuses to strip types from a .ts file
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING): `node pane/main.ts` died on
 * its first line and herdr closed the pane. So the types are stripped here,
 * with node's own function, and the peers are resolved from the pi that
 * produced the mirror's events - the pane command passes its entry in
 * COMBO_PI - because a pane started from a shell has no other way to find them.
 */

import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const PEERS = /^(@earendil-works\/|typebox(\/|$))/;
const pi = process.env.COMBO_PI;

registerHooks({
	resolve: (specifier, context, next) =>
		pi && PEERS.test(specifier) ? next(specifier, { ...context, parentURL: pi }) : next(specifier, context),
	load: (url, context, next) =>
		url.endsWith(".ts")
			? {
					format: "module",
					source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8")),
					shortCircuit: true,
				}
			: next(url, context),
});

await import(new URL("./main.ts", import.meta.url).href);
