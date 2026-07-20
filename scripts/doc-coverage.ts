/**
 * Which exports are still undocumented - as data, so a test can fail on it.
 *
 * "Everything is documented" is a claim that decays the day it is made, unless
 * something checks. This walks the source and reports every gap; the rule it
 * enforces is deliberately not "every symbol everywhere":
 *
 * - **every exported top-level declaration** of `src/` and `extension/` needs a
 *   TSDoc, and every file needs a header saying why it exists;
 * - **members are required on the public surface only** - what `src/index.ts`
 *   re-exports. An options type a caller has to fill in is unusable without a
 *   word per field, whereas an internal record shape is read next to its one
 *   use, and demanding prose there produces the comment that restates the
 *   signature - the exact noise `AGENTS.md` forbids.
 *
 * A TSDoc that says nothing still passes here. Nothing can check that; review
 * can. What this prevents is the silent gap.
 */

import ts from "typescript";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { declaredNames, docAt, isExported, moduleIntro, parseFile, publicNames } from "./api-docs.ts";

/** Directories walked. Tests and examples document themselves by being read. */
export const DOCUMENTED_DIRS = ["src", "extension"];

/** One missing piece of documentation, named the way a reader would look for it. */
export type DocGap = {
	/** Path relative to the repository root. */
	file: string;
	/** `spawn`, `SpawnOptions.lifetime`, or `<file header>`. */
	symbol: string;
};

/** Every `.ts` file under `dir`, recursively, in a stable order. */
export function sourceFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
		else if (path.endsWith(".ts")) found.push(path);
	}
	return found;
}

const membersOf = (st: ts.Statement): readonly ts.TypeElement[] => {
	if (ts.isInterfaceDeclaration(st)) return st.members;
	if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) return st.type.members;
	if (ts.isTypeAliasDeclaration(st) && ts.isIntersectionTypeNode(st.type)) {
		return st.type.types.flatMap((t) => (ts.isTypeLiteralNode(t) ? [...t.members] : []));
	}
	return [];
};

const memberName = (member: ts.TypeElement): string | undefined =>
	member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : undefined;

/**
 * Every documentation gap in the repository, in file order.
 *
 * An empty array is the passing state; the array itself is the failure message,
 * which is why it carries names rather than a count.
 */
export function docGaps(root: string): DocGap[] {
	const publicSurface = new Set(publicNames(join(root, "src/index.ts")));
	const gaps: DocGap[] = [];

	for (const dir of DOCUMENTED_DIRS) {
		for (const path of sourceFiles(join(root, dir))) {
			const file = relative(root, path);
			const { text, sf } = parseFile(path);
			if (!moduleIntro(text)) gaps.push({ file, symbol: "<file header>" });

			for (const st of sf.statements) {
				if (!isExported(st)) continue;
				const names = declaredNames(st);
				if (names.length === 0) continue;
				const start = st.getStart(sf);
				if (!docAt(text, st.pos, start)) {
					for (const name of names) gaps.push({ file, symbol: name });
				}
				if (!names.some((name) => publicSurface.has(name))) continue;
				for (const member of membersOf(st)) {
					const name = memberName(member);
					if (!name) continue;
					if (!docAt(text, member.pos, member.getStart(sf))) {
						gaps.push({ file, symbol: `${names[0]}.${name}` });
					}
				}
			}
		}
	}
	return gaps;
}
