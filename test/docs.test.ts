/**
 * The documentation, checked the way the code is.
 *
 * Four failures this catches, every one of them invisible until now: an export
 * that ships with no TSDoc, a `docs/reference/api/` page that no longer matches the source
 * it was generated from, a link or a navigation entry pointing at nothing, and a
 * code example importing a symbol that has since been renamed. Neither a
 * typechecker nor any other test in this suite reads Markdown, so without this
 * file "the documentation is up to date" is a claim nobody verifies.
 *
 * When it fails on freshness, the fix is `npm run docs` - the generator is the
 * single source, and this test only compares.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { DOCS_DIR, docAt, generateDocs, moduleIntro, signatureOf, parseFile } from "../scripts/api-docs.ts";
import { docGaps, sourceFiles } from "../scripts/doc-coverage.ts";
import { brokenLinks, docPages, handWritten, navigationPaths, unknownImports } from "../scripts/doc-links.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("documentation coverage", () => {
	test("every export carries a TSDoc, and every file a header", () => {
		const gaps = docGaps(root).map((gap) => `${gap.file}: ${gap.symbol}`);
		assert.deepEqual(gaps, [], `undocumented:\n  ${gaps.join("\n  ")}`);
	});

	test("the public surface is what src/index.ts re-exports, and it is all on a page", () => {
		const pages = [...generateDocs(root).keys()];
		assert.ok(pages.includes(join(DOCS_DIR, "index.md")));
		assert.ok(pages.length > 20, "a page per declaring module");
	});
});

describe("docs/reference/api is generated, never edited", () => {
	const generated = generateDocs(root);

	test("every page matches what the source says today", () => {
		// The names of the stale files, not their contents: a failing assertion
		// on two full pages is four kilobytes nobody reads.
		const stale = [...generated]
			.filter(([path, expected]) => readFileSync(join(root, path), "utf8") !== expected)
			.map(([path]) => path);
		assert.deepEqual(stale, [], "stale pages - run `npm run docs`");
	});

	test("no page survives the module it documented", () => {
		const onDisk = readdirSync(join(root, DOCS_DIR), { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => relative(root, join(entry.parentPath, entry.name)))
			.sort();
		assert.deepEqual(onDisk, [...generated.keys()].sort(), "run `npm run docs`");
	});
});

describe("the hand-written pages", () => {
	const pages = docPages(root);
	const prose = handWritten(pages);

	test("every relative link resolves", () => {
		assert.deepEqual(brokenLinks(root, pages), []);
	});

	test("every page is reachable from a toctree, and every entry exists", () => {
		const navigation = navigationPaths(root);
		const missing = prose.filter((page) => !navigation.includes(page));
		assert.deepEqual(missing, [], "pages nobody can navigate to");
		assert.deepEqual(
			navigation.filter((path) => !pages.includes(path)),
			[],
			"navigation entries pointing at nothing",
		);
	});

	test("every symbol an example imports is really exported", () => {
		assert.deepEqual(unknownImports(root, pages), []);
	});
});

describe("reading TSDoc out of the source", () => {
	test("a file header is not mistaken for the first symbol's documentation", () => {
		const text = '/**\n * Why this module exists.\n */\n\nimport x from "y";\n\nexport const a = 1;\n';
		const { sf } = parseFile(join(root, "src/result.ts"));
		assert.equal(moduleIntro(text), "Why this module exists.");
		assert.ok(sf.statements.length > 0);
	});

	test("a comment separated by a blank line documents nothing", () => {
		const text = "/** Far above. */\n\nexport const a = 1;\n";
		assert.equal(docAt(text, 0, text.indexOf("export")), "");
	});

	test("an adjacent comment documents the declaration below it", () => {
		const text = "/** Right above. */\nexport const a = 1;\n";
		assert.equal(docAt(text, 0, text.indexOf("export")), "Right above.");
	});

	test("a function signature is shown without its body", () => {
		const { text, sf } = parseFile(join(root, "src/run.ts"));
		const declaration = sf.statements.find((st) => st.getText(sf).includes("export async function run"));
		assert.ok(declaration);
		const signature = signatureOf(text, sf, declaration);
		assert.ok(signature.endsWith("{ /* … */ }"), signature);
		assert.ok(!signature.includes("await"), "the body is not part of the reference");
	});

	test("a type is shown whole, so its members keep their documentation", () => {
		const { text, sf } = parseFile(join(root, "src/usage.ts"));
		const declaration = sf.statements.find((st) => st.getText(sf).includes("export type Usage"));
		assert.ok(declaration);
		assert.match(signatureOf(text, sf, declaration), /wallMs/);
	});

	test("every source file is walked, tests and examples are not", () => {
		const walked = sourceFiles(join(root, "src")).map((path) => relative(root, path));
		assert.ok(walked.includes("src/subagent.ts"));
		assert.ok(!walked.some((path) => path.includes("test/")));
	});
});
