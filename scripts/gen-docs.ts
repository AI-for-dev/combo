/**
 * Writes `docs/reference/api/` from the source. `npm run docs`.
 *
 * The generation is deliberately destructive over its own directory: a page for
 * a module that no longer exists is worse than no page, because it reads as
 * current. `test/docs.test.ts` checks the result against what is committed, so
 * forgetting to run this is a failing test rather than a stale reference.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOCS_DIR, generateDocs } from "./api-docs.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = generateDocs(root);

rmSync(join(root, DOCS_DIR), { recursive: true, force: true });
for (const [path, content] of files) {
	const full = join(root, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
}

const count = readdirSync(join(root, DOCS_DIR), { recursive: true }).length;
console.log(`${DOCS_DIR}: ${files.size} pages (${count} entries)`);
