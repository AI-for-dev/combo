/**
 * pi's packages for the pane, taken from the pi that opened it.
 *
 * They are peer dependencies, and `pi install` does not install peers: inside
 * pi they are the host's, but a pane is a process of its own, started by a
 * shell, and nothing sits beside the package for it to import. So the pane
 * command preloads this module (`node --import`) and passes `--pi <url>`, a
 * file inside the package of the pi whose events the pane draws
 * (`piPackageUrl()`), and every import of one of pi's packages is resolved
 * from there. That also keeps the pane on that pi's version rather than on
 * whatever copy a clone's `node_modules` holds.
 */

import { registerHooks } from "node:module";

const PEERS = /^(@earendil-works\/|typebox(\/|$))/;
const at = process.argv.indexOf("--pi");
const pi = at === -1 ? undefined : process.argv[at + 1];

if (pi) {
	registerHooks({
		resolve: (specifier, context, next) => next(specifier, PEERS.test(specifier) ? { ...context, parentURL: pi } : context),
	});
}
