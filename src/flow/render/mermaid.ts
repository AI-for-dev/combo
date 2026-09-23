/**
 * A checked flow as a Mermaid `flowchart`: the structure and nothing else.
 *
 * A sequence is arrows, a block is a `subgraph`, and each node that acts is
 * one box with its kind and id. What changes the path is written on it: a
 * `choice` case's condition on its arrow, a loop's `until` on its way back,
 * every `max`, and `on-fail: continue`. `reads:` are left out: drawn as
 * arrows, they would double and cross the ones that say what runs next. A
 * call is one box, its callee drawn on its own.
 *
 * Mermaid's ids are numbered in drawing order rather than taken from the
 * file, since an id such as `end` would end a subgraph: the text is the same
 * for the same flow, and every label carries the node's own id.
 */

import { itemsOf } from "../bounds.ts";
import type { CheckedFlow, CheckedNode } from "../checked.ts";

/** A drawn sequence: the element its first arrow leaves from and its last arrow reaches. */
type Ends = { readonly first: string; readonly last: string };

/** `checked` as the text of a Mermaid `flowchart`, pure. */
export function mermaidOf(checked: CheckedFlow): string {
	const drawing = new Drawing();
	drawing.sequence(checked.nodes, 1);
	return ["flowchart TD", ...drawing.lines].join("\n");
}

class Drawing {
	readonly lines: string[] = [];
	private count = 0;

	/** `nodes` drawn at `depth`, each after the one before it; `undefined` when there are none. */
	sequence(nodes: readonly CheckedNode[], depth: number): Ends | undefined {
		const drawn = nodes.map((node) => this.node(node, depth));
		for (let i = 1; i < drawn.length; i++) this.line(depth, `${drawn[i - 1]} --> ${drawn[i]}`);
		return drawn.length === 0 ? undefined : { first: drawn[0] as string, last: drawn[drawn.length - 1] as string };
	}

	private node(node: CheckedNode, depth: number): string {
		const mark = node.continueOnFail ? ["on-fail: continue"] : [];
		switch (node.kind) {
			case "agent":
				return this.box(depth, [node.id, `agent ${"from" in node.agent ? [...node.agent.among.keys()].join(" or ") : node.agent.name}`, ...mark]);
			case "check":
				return this.box(depth, [node.id, `check ${node.script}`, ...mark]);
			case "commit":
			case "ask":
				return this.box(depth, [node.id, node.kind, ...mark]);
			case "flow":
				return this.box(depth, [node.id, `flow ${node.callee.name}`, node.callee.file, `input: ${node.input.address}`, ...mark], "[[", "]]");
			case "choice":
				return this.subgraph(depth, ["choice", node.id, ...mark], (inner) => {
					const decide = this.box(inner, ["case"], "{", "}");
					for (const one of node.cases) {
						const { first } = this.sequence(one.nodes, inner) as Ends;
						this.line(inner, `${decide} -->|"${escape(one.when.source.trim())}"| ${first}`);
					}
					const otherwise = this.sequence(node.otherwise, inner)?.first ?? this.box(inner, ["nothing"], "((", "))");
					this.line(inner, `${decide} -->|"default"| ${otherwise}`);
				});
			case "parallel":
				return this.subgraph(depth, ["parallel", node.id, ...mark], (inner) => {
					for (const branch of node.branches) this.subgraph(inner, ["branch", branch.name], (deeper) => this.sequence(branch.nodes, deeper));
				});
			case "map": {
				const bound = "items" in node.over ? `${itemsOf(node)} items` : `max ${node.max}`;
				return this.subgraph(depth, ["map", `${node.id} · ${bound}`, ...mark], (inner) => this.sequence(node.nodes, inner));
			}
			case "loop":
				return this.subgraph(depth, ["loop", `${node.id} · max ${node.max}`, ...mark], (inner) => {
					const body = this.sequence(node.nodes, inner) as Ends;
					this.line(inner, `${body.last} -.->|"until ${escape(node.until.source.trim())}"| ${body.first}`);
				});
		}
	}

	/** A box of `parts`, one per line, in the shape `open` and `close` make. */
	private box(depth: number, parts: readonly string[], open = "[", close = "]"): string {
		const id = this.next();
		this.line(depth, `${id}${open}"${parts.map(escape).join("<br/>")}"${close}`);
		return id;
	}

	/** A subgraph titled by its kind and what follows, holding what `inside` draws one level deeper. */
	private subgraph(depth: number, [kind, ...rest]: readonly string[], inside: (depth: number) => void): string {
		const id = this.next();
		this.line(depth, `subgraph ${id}["${escape([`${kind} ${rest[0]}`, ...rest.slice(1)].join(" · "))}"]`);
		inside(depth + 1);
		this.line(depth, "end");
		return id;
	}

	private next(): string {
		return `n${++this.count}`;
	}

	private line(depth: number, text: string): void {
		this.lines.push(`${"  ".repeat(depth)}${text}`);
	}
}

/** Text inside a quoted label: what Mermaid or the HTML it draws would read as markup, as entity codes. */
function escape(text: string): string {
	return text.replace(/[#"<>&]/g, (char) => `#${char.charCodeAt(0)};`);
}
