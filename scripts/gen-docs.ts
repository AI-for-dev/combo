/**
 * Writes `docs/reference/api/` from the source and `docs/reference/flows/`
 * from the shipped flows. `npm run docs`.
 *
 * The generation is deliberately destructive over its own directories: a page
 * for a module or a flow that no longer exists is worse than no page, because
 * it reads as current. `test/docs.test.ts` checks the result against what is
 * committed, so forgetting to run this is a failing test rather than a stale
 * reference.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_DIR, generateDocs } from "./api-docs.ts";
import { FLOWS_DOCS_DIR, generateShippedFlowDocs } from "./flow-docs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const [dir, files] of [
	[DOCS_DIR, generateDocs(root)],
	[FLOWS_DOCS_DIR, generateShippedFlowDocs(root)],
] as const) {
	rmSync(join(root, dir), { recursive: true, force: true });
	for (const [path, content] of files) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content);
	}
	console.log(`${dir}: ${files.size} pages`);
}
