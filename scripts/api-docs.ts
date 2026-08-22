/**
 * The API reference, read out of the source rather than written beside it.
 *
 * A reference page maintained by hand is a second copy of the code, and the
 * copy is wrong the moment someone edits a signature - silently, because
 * nothing in a test suite reads Markdown. So `docs/reference/api/` is
 * **generated** from the TSDoc of what `src/index.ts` re-exports, and
 * `test/docs.test.ts` fails when the checked-in files no longer match what this
 * module produces. Drift stops being a matter of discipline.
 *
 * Why the TypeScript compiler API rather than a documentation generator: it is
 * already a devDependency (it is what `npm run typecheck` runs), and "no
 * dependency without discussion" holds here as everywhere else.
 *
 * This file turns source into a documentation model and renders it. Writing the
 * files is `gen-docs.ts`, so the model can be asserted on in memory.
 */

import ts from "typescript";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** One documented export: what it is called, how it reads, what it promises. */
export type DocSymbol = {
	/** The exported name, as `src/index.ts` re-exports it. */
	name: string;
	/** `function`, `type`, `class` or `const` - the word shown next to the name. */
	kind: string;
	/** The declaration, bodies stripped; type declarations keep their members' TSDoc. */
	signature: string;
	/** The TSDoc, `*` markers removed. Empty when the export carries none. */
	doc: string;
};

/** One page: the exports declared in a single source file. */
export type DocModule = {
	/** Path of the declaring file, relative to the repository root. */
	file: string;
	/** Path of the generated page, relative to the repository root. */
	page: string;
	/** The file's own header TSDoc - why the module exists, before what it exports. */
	intro: string;
	/** In declaration order, which is the order the author chose to explain them. */
	symbols: DocSymbol[];
};

/** Where the generated pages live. Anything else under it is not ours to keep. */
export const DOCS_DIR = "docs/reference/api";

/** A repository path, as a link from a generated page. */
const fromApi = (target: string): string => relative(DOCS_DIR, target).split("\\").join("/");

const parse = (file: string): { text: string; sf: ts.SourceFile } => {
	const text = readFileSync(file, "utf8");
	return { text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true) };
};

/**
 * The TSDoc immediately above `pos`, or `""`.
 *
 * "Immediately" is the whole point: a file header is separated from the first
 * statement by a blank line, a symbol's TSDoc never is, and that is the only
 * signal in the text that tells the two apart.
 */
export function docAt(text: string, pos: number, end: number): string {
	const ranges = ts.getLeadingCommentRanges(text, pos) ?? [];
	const last = ranges.at(-1);
	if (!last || !text.slice(last.pos, last.end).startsWith("/**")) return "";
	if (text.slice(last.end, end).includes("\n\n")) return "";
	return stripStars(text.slice(last.pos, last.end));
}

/** Turns a `/** … *\/` block into its prose, one line per line, `*` markers gone. */
export function stripStars(comment: string): string {
	return comment
		.replace(/^\/\*\*/, "")
		.replace(/\*\/$/, "")
		.split("\n")
		.map((line) => line.replace(/^\s*\* ?/, ""))
		.join("\n")
		.trim();
}

/** The file's header TSDoc: the block at the top, followed by a blank line. */
export function moduleIntro(text: string): string {
	if (!text.startsWith("/**")) return "";
	const end = text.indexOf("*/");
	if (end === -1) return "";
	if (!text.slice(end + 2, end + 4).startsWith("\n\n")) return "";
	return stripStars(text.slice(0, end + 2));
}

/** Reads and parses a file once, keeping the text: TSDoc lives in the trivia. */
export function parseFile(file: string): { text: string; sf: ts.SourceFile } {
	return parse(file);
}

/** The names a statement declares - several, for `export const a = 1, b = 2`. */
export const declaredNames = (st: ts.Statement): string[] => {
	if (ts.isVariableStatement(st)) {
		return st.declarationList.declarations
			.map((d) => (ts.isIdentifier(d.name) ? d.name.text : ""))
			.filter(Boolean);
	}
	if (
		(ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
		st.name
	) {
		return [st.name.text];
	}
	return [];
};

/** Whether a top-level statement carries the `export` keyword. */
export const isExported = (st: ts.Statement): boolean =>
	ts.canHaveModifiers(st) && (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

const kindOf = (st: ts.Statement): string => {
	if (ts.isFunctionDeclaration(st)) return "function";
	if (ts.isClassDeclaration(st)) return "class";
	if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) return "type";
	return "const";
};

/**
 * The declaration as a reader needs it: no function body, no long initialiser.
 *
 * Type declarations are kept **verbatim**, because their members' TSDoc is part
 * of the answer - a page that listed `DeliverOptions` without saying what
 * `maxRounds` does would send the reader back to the source, which is the
 * failure this whole file exists to prevent.
 */
export function signatureOf(text: string, sf: ts.SourceFile, st: ts.Statement): string {
	const start = st.getStart(sf);
	if (ts.isFunctionDeclaration(st)) {
		const cut = st.body ? st.body.getStart(sf) : st.end;
		return `${text.slice(start, cut).trim()}${st.body ? " { … }" : ""}`;
	}
	if (ts.isClassDeclaration(st)) {
		const header = text.slice(start, st.members.pos).trim();
		const members = st.members
			.filter((m) => m.name && !(ts.canHaveModifiers(m) ? ts.getModifiers(m) ?? [] : []).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword))
			.map((m) => {
				const body = ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) ? m.body : undefined;
				const to = body ? body.getStart(sf) : m.end;
				return `\t${text.slice(m.getStart(sf), to).trim().replace(/;$/, "")}${body ? " { … }" : ";"}`;
			});
		return [header, ...members, "}"].join("\n");
	}
	if (ts.isVariableStatement(st)) {
		const decl = text.slice(start, st.end).trim();
		return decl.split("\n").length > 6 ? `${decl.split("\n")[0]} … ;` : decl;
	}
	return text.slice(start, st.end).trim();
}

type Declaration = { file: string; text: string; sf: ts.SourceFile; st: ts.Statement };

/** Every exported declaration of a file, by name, following its re-exports. */
function declarations(file: string, seen = new Set<string>()): Map<string, Declaration> {
	const found = new Map<string, Declaration>();
	if (seen.has(file)) return found;
	seen.add(file);

	const { text, sf } = parse(file);
	for (const st of sf.statements) {
		if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
			const target = join(dirname(file), st.moduleSpecifier.text);
			for (const [name, decl] of declarations(target, seen)) found.set(name, decl);
			continue;
		}
		if (!isExported(st)) continue;
		for (const name of declaredNames(st)) found.set(name, { file, text, sf, st });
	}
	return found;
}

/** The names `entry` re-exports, in the order it lists them. */
export function publicNames(entry: string): string[] {
	const { sf } = parse(entry);
	const names: string[] = [];
	for (const st of sf.statements) {
		if (!ts.isExportDeclaration(st) || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
		for (const spec of st.exportClause.elements) names.push(spec.name.text);
	}
	return names;
}

/**
 * The public API, grouped by the file that declares it.
 *
 * Grouped by *declaring* file rather than by re-exporting barrel: `reporters/`
 * is one export line in `src/index.ts` and four genuinely different concerns,
 * and a page per concern is the only grouping that stays readable as the
 * library grows.
 */
export function collectPublicApi(root: string, entry = "src/index.ts"): DocModule[] {
	const declared = declarations(join(root, entry));
	const wanted = new Set(publicNames(join(root, entry)));
	const pages = new Map<string, DocModule>();

	for (const [name, decl] of declared) {
		if (!wanted.has(name)) continue;
		const file = relative(root, decl.file);
		let page = pages.get(file);
		if (!page) {
			page = {
				file,
				page: join(DOCS_DIR, `${file.replace(/^src\//, "").replace(/\.ts$/, "")}.md`),
				intro: moduleIntro(decl.text),
				symbols: [],
			};
			pages.set(file, page);
		}
		page.symbols.push({
			name,
			kind: kindOf(decl.st),
			signature: signatureOf(decl.text, decl.sf, decl.st),
			doc: docAt(decl.text, decl.st.pos, decl.st.getStart(decl.sf)),
		});
	}

	for (const page of pages.values()) {
		page.symbols.sort((a, b) => a.name.localeCompare(b.name));
	}
	return [...pages.values()].sort((a, b) => a.file.localeCompare(b.file));
}

const GENERATED = "<!-- Generated by scripts/gen-docs.ts from the TSDoc in src/. Do not edit by hand. -->";

/** One page of reference: the module's own header, then each export it declares. */
export function renderModule(module: DocModule): string {
	const title = module.file.replace(/^src\//, "").replace(/\.ts$/, "");
	const lines = [GENERATED, "", `# \`${title}\``, "", `Source: [\`${module.file}\`](${sourceLink(module)})`, ""];
	if (module.intro) lines.push(module.intro, "");
	for (const symbol of module.symbols) {
		lines.push(`## \`${symbol.name}\``, "", `*${symbol.kind}*`, "", "```typescript", symbol.signature, "```", "");
		if (symbol.doc) lines.push(symbol.doc, "");
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

const sourceLink = (module: DocModule): string =>
	`${relative(dirname(module.page), module.file).split("\\").join("/")}`;

/** The index: every module, its one-line purpose, and what it exports. */
export function renderIndex(modules: DocModule[]): string {
	const lines = [
		GENERATED,
		"",
		"# API reference",
		"",
		"Generated from the TSDoc of everything `src/index.ts` exports. The intent",
		`behind the design lives in [Design decisions](${fromApi("docs/decisions.md")}); how to use the`,
		`library, in [\`README.md\`](${fromApi("README.md")}); this is the exhaustive surface.`,
		"",
		"| Module | What it is for | Exports |",
		"| --- | --- | --- |",
	];
	for (const module of modules) {
		const title = module.file.replace(/^src\//, "").replace(/\.ts$/, "");
		const link = relative(DOCS_DIR, module.page).split("\\").join("/");
		lines.push(`| [\`${title}\`](${link}) | ${firstSentence(module.intro)} | ${module.symbols.length} |`);
	}
	return `${lines.join("\n")}\n`;
}

const firstSentence = (intro: string): string => {
	const first = intro.split("\n\n")[0] ?? "";
	const flat = first.replace(/\n/g, " ").replace(/\|/g, "\\|").trim();
	return flat.endsWith(".") ? flat : `${flat}${flat ? "." : ""}`;
};

/**
 * The whole of `docs/reference/api/`, as paths mapped to contents.
 *
 * Returned rather than written so the test can compare it against the checked-in
 * files without a temporary directory - the comparison *is* the freshness check.
 */
export function generateDocs(root: string): Map<string, string> {
	const modules = collectPublicApi(root);
	const files = new Map<string, string>();
	files.set(join(DOCS_DIR, "index.md"), renderIndex(modules));
	for (const module of modules) files.set(module.page, renderModule(module));
	return files;
}
