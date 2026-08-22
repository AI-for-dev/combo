/**
 * The faces the site serves cover the pages it serves.
 *
 * A character no vendored face carries does not fail: it is drawn from whatever the
 * reader happens to have installed, at a different weight and on a different baseline,
 * and only they ever see it. That is the quietest kind of defect this documentation can
 * have, and the subset in `docs/_static/fonts/` is deliberately small, so it is also a
 * likely one.
 *
 * `scripts/subset-fonts.py` writes `coverage.json` from the cmap of the files it actually
 * produced - not from the range it was asked for - and this compares the prose of every
 * page against it. Code is excluded: fenced blocks and inline spans are set in the
 * reader's own monospace, which this repository does not ship and cannot vouch for.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { docPages } from "../scripts/doc-links.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const FENCED = /^```[\s\S]*?^```/gm;
const INLINE = /`[^`\n]*`/g;

/** A page as a reader sees it set in the serif and the sans: everything but the code. */
const prose = (text: string): string => text.replace(FENCED, " ").replace(INLINE, " ");

const named = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

describe("the vendored faces", () => {
	const { codepoints } = JSON.parse(readFileSync(join(root, "docs/_static/fonts/coverage.json"), "utf8")) as {
		codepoints: number[];
	};
	const covered = new Set(codepoints);

	test("carry every character the prose of every page uses", () => {
		const missing = new Set<string>();
		for (const page of docPages(root)) {
			for (const character of prose(readFileSync(join(root, page), "utf8"))) {
				const code = character.codePointAt(0) as number;
				// Whitespace and the line endings around it are not drawn.
				if (code < 0x20 || covered.has(code)) continue;
				missing.add(`${page}: ${named(code)} ${character}`);
			}
		}
		assert.deepEqual([...missing], [], "characters no shipped face carries - widen scripts/fonts.json and re-run");
	});

	test("cover the Latin the pages are written in, not merely ASCII", () => {
		// A subset that lost its punctuation would pass the test above the day every page
		// happens to use none of it. These are the marks this prose is actually set with.
		for (const character of ["é", "ï", "—", "–", "…", "→", "·", "×", "“", "”", "’"]) {
			assert.ok(covered.has(character.codePointAt(0) as number), `${named(character.codePointAt(0) as number)} ${character}`);
		}
	});
});
