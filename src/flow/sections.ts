/**
 * A flow's body: one `## <id>` section per `agent` node, and nothing else.
 *
 * Text no turn reads is text its author believes a model saw, so text before
 * the first section is refused, and so are an empty section and one written
 * twice. `###` headings are prose inside a section, and a `##` inside a fenced
 * code block is prose too: a section may show the Markdown it asks for.
 */

/** One section, and where it failed to be one. */
export type SectionProblem = { readonly code: "body-preamble" | "section-empty" | "section-duplicate"; readonly at: string; readonly message: string };

/** The sections of a body, by id, in the order written, and what was refused. */
export type Sections = { readonly sections: ReadonlyMap<string, string>; readonly problems: readonly SectionProblem[] };

const HEADING = /^##[ \t]+(\S.*?)[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Cuts `body` into its sections. */
export function readSections(body: string): Sections {
	const sections = new Map<string, string>();
	const problems: SectionProblem[] = [];
	const preamble: string[] = [];
	let current: { id: string; lines: string[] } | undefined;
	let fence: string | undefined;

	const close = () => {
		if (current === undefined) return;
		const text = current.lines.join("\n").trim();
		if (sections.has(current.id)) {
			problems.push({ code: "section-duplicate", at: current.id, message: `\`## ${current.id}\` is written twice` });
		} else if (text === "") {
			problems.push({ code: "section-empty", at: current.id, message: `\`## ${current.id}\` says nothing: every turn is asked something` });
		}
		if (!sections.has(current.id)) sections.set(current.id, text);
	};

	for (const line of body.split("\n")) {
		const marker = FENCE.exec(line)?.[1];
		if (marker !== undefined && (fence === undefined || marker.startsWith(fence))) fence = fence === undefined ? marker : undefined;
		const heading = fence === undefined && marker === undefined ? HEADING.exec(line) : null;
		if (heading) {
			close();
			current = { id: heading[1] as string, lines: [] };
		} else {
			(current?.lines ?? preamble).push(line);
		}
	}
	close();

	if (preamble.join("").trim() !== "") {
		problems.unshift({ code: "body-preamble", at: "", message: "text before the first `## <id>` section reaches no turn; document a flow in `description:` or a YAML comment" });
	}
	return { sections, problems };
}
