/**
 * The live view of a flow run: its plan, filled from the journal and the
 * event stream, folded by the state of each visit.
 *
 * A visit running now is expanded, one that ended is one line saying how,
 * and one not made yet is its plan line. Every iteration a loop ran, every
 * `map` item and every `parallel` branch keeps a line while its block runs,
 * folded once it ended. A running call expands its callee's plan under it. A
 * `choice`'s cases are one line until it decides, `case 1, default`, then
 * the case it took and one line for the ones it did not. A node its sequence never reached, a
 * failure or a stop having ended it, keeps its line with nothing more.
 *
 * It is a pure fold, like `picture.ts` beside it: the same journal and
 * events give the same frame, and nothing here draws.
 */

import type { SubagentEvent } from "../../events.ts";
import { costOf } from "../../measure/index.ts";
import type { Usage } from "../../usage.ts";
import type { CheckedFlow, CheckedNode } from "../checked.ts";
import type { JournalEntry } from "../run/index.ts";
import { outcome, stopsSequence } from "./outcome.ts";
import { planOf, type PlanLine } from "./plan.ts";
import { summaryOf, type LiveSummary } from "./summary.ts";
import { Visits } from "./visits.ts";

/**
 * Where a line stands. `working`, `blocked` (an `ask` waiting for its
 * answer), `done` and `failed` are a subagent's standings too; `pending` is
 * not visited yet, and `unreached` never will be in this life.
 */
export type LiveState = "pending" | "working" | "blocked" | "done" | "failed" | "unreached";

/** One line of the live view, and the lines under it. */
export type LiveLine = {
	/** A plan line's kind, an iteration, a `map` item, or the cases of a `choice` it did not take. */
	readonly kind: PlanLine["kind"] | "iteration" | "item" | "cases";
	/** What the line is called: its visit path, `case 1`, `default`, or the cases it folds. */
	readonly label: string;
	/** The visit path; a case keeps its choice's, and a pending line inside a block its plan's `#n` and `[i]`. */
	readonly path: string;
	readonly state: LiveState;
	/** The plan's facts while pending, what is under way while running, and how it ended once over. */
	readonly facts: readonly string[];
	/** The plan's bound, while pending. */
	readonly bound?: PlanLine["bound"];
	/** What it cost, once over: `wallMs` is its time. */
	readonly usage?: Usage;
	/** The subagents spawned for an `agent` visit. */
	readonly subagents: readonly string[];
	readonly lines: readonly LiveLine[];
};

/** A run's live view: the flow, the one-line summary, and its root sequence. */
export type LivePlan = { readonly flow: string; readonly summary: LiveSummary; readonly lines: readonly LiveLine[] };

/**
 * The live view of the run of `checked`: `journal` is what its earlier lives
 * wrote, `events` what this one told. A finished run's journal alone draws
 * its last frame, and a live run's events alone draw it as it goes.
 */
export function livePlan(checked: CheckedFlow, journal: readonly JournalEntry[], events: readonly SubagentEvent[]): LivePlan {
	const visits = new Visits(checked, journal, events);
	const fold = new Fold(visits);
	const lines = fold.sequence(checked.nodes, planOf(checked).lines, "", visits.runEnd !== undefined);
	return { flow: checked.name, summary: summaryOf(visits, fold.over(checked.nodes, "")), lines };
}

class Fold {
	private readonly visits: Visits;

	constructor(visits: Visits) {
		this.visits = visits;
	}

	/** `nodes` inside the visit `prefix`, `plans` their plan lines; `closed` when what holds them is over. */
	sequence(nodes: readonly CheckedNode[], plans: readonly PlanLine[], prefix: string, closed: boolean): LiveLine[] {
		let stopped = false;
		return nodes.map((node, i) => {
			const path = prefix === "" ? node.id : `${prefix}/${node.id}`;
			const plan = plans[i] as PlanLine;
			if (stopped) return line(plan, path, "unreached");
			const end = this.visits.ended(path);
			if (end !== undefined) {
				stopped = !end.ok && stopsSequence(node, end);
				return { ...line(plan, path, end.ok ? "done" : "failed", outcome(node, end)), usage: { ...end.usage, wallMs: end.wallMs }, subagents: this.visits.subagents(path) };
			}
			// A visit begun and not ended is open: running now, or cut short by a kill.
			if (this.visits.live(path) || this.visits.touched(path)) return this.open(node, plan, path);
			return closed ? line(plan, path, "unreached") : pending(plan, path);
		});
	}

	/**
	 * A visit begun and not ended, expanded: `working` while it runs, and
	 * `blocked` for an `ask` waiting; `pending` when a kill cut it short, and
	 * a resume will carry it on.
	 */
	private open(node: CheckedNode, plan: PlanLine, path: string): LiveLine {
		const now = this.visits.live(path);
		const state = now ? "working" : "pending";
		const open = (facts: string[], lines: LiveLine[] = []) => ({ ...line(plan, path, state, facts), lines });
		switch (node.kind) {
			case "agent":
				return { ...open([]), subagents: this.visits.subagents(path) };
			case "ask":
				return { ...open(plan.facts.slice(0, 1)), state: now ? "blocked" : state };
			case "check":
			case "commit":
				return open([]);
			case "flow":
				return open([], this.sequence(node.callee.nodes, planOf(node.callee).lines, path, false));
			case "choice": {
				const cases = [...node.cases.map((one) => one.nodes), node.otherwise];
				const taken = cases.findIndex((nodes) => nodes.some((one) => this.visits.touched(`${path}/${one.id}`)));
				if (taken < 0) return open([], [casesLine(path, plan.lines)]);
				const chosen = plan.lines[taken] as PlanLine;
				const others = plan.lines.filter((_, i) => i !== taken);
				const inside = this.sequence(cases[taken] as CheckedNode[], chosen.lines, path, false);
				return open([], [{ ...line(chosen, path, state, chosen.facts), label: caseLabel(chosen), lines: inside }, ...(others.length > 0 ? [casesLine(path, others, "not taken: ")] : [])]);
			}
			case "parallel": {
				const branches = node.branches.map((branch, i) => this.branch("branch", `${path}/${branch.name}`, branch.nodes, (plan.lines[i] as PlanLine).lines, now));
				return open([ended(branches, branches.length)], branches);
			}
			case "map": {
				let seen = 0;
				while (this.visits.touched(`${path}[${seen + 1}]`)) seen++;
				const known = "items" in node.over ? node.over.items.length : this.visits.items(path);
				const items = Array.from({ length: Math.max(known ?? 0, seen) }, (_, i) => this.branch("item", `${path}[${i + 1}]`, node.nodes, plan.lines, now));
				return open([known === undefined ? `${ended(items, items.length)} so far` : ended(items, known)], items);
			}
			case "loop": {
				let n = 1;
				while (n < node.max && this.visits.touched(`${path}#${n + 1}`)) n++;
				const iterations = Array.from({ length: n }, (_, i) => this.branch("iteration", `${path}#${i + 1}`, node.nodes, plan.lines, now, i + 1 === n));
				return open([`#${n} of ${node.max}`], iterations);
			}
		}
	}

	/**
	 * A branch, an item or an iteration at `prefix`, `plans` its nodes' plan
	 * lines: one line once its sequence is over, expanded while under way,
	 * and one line before it starts, unless it is the loop's current one. It
	 * is `working` while its block runs `now`: the moment between two of its
	 * visits is still its work.
	 */
	private branch(kind: "branch" | "item" | "iteration", prefix: string, nodes: readonly CheckedNode[], plans: readonly PlanLine[], now: boolean, current = false): LiveLine {
		const own = { kind, label: prefix, path: prefix, subagents: [], lines: [] };
		const over = this.over(nodes, prefix);
		if (over !== undefined) return { ...own, state: over.ok ? "done" : "failed", facts: over.facts, usage: costOf(this.visits.endedIn(prefix)) };
		if (!current && !this.visits.touched(prefix)) return { ...own, state: "pending", facts: [] };
		return { ...own, state: now ? "working" : "pending", facts: [], lines: this.sequence(nodes, plans, prefix, false) };
	}

	/** How the sequence `nodes` inside `prefix` ended, and the failure that ended it; nothing while it goes on or before it starts. */
	over(nodes: readonly CheckedNode[], prefix: string): { readonly ok: boolean; readonly facts: string[] } | undefined {
		for (const node of nodes) {
			const end = this.visits.ended(prefix === "" ? node.id : `${prefix}/${node.id}`);
			if (end === undefined) return undefined;
			if (!end.ok && stopsSequence(node, end)) return { ok: false, facts: outcome(node, end) };
		}
		return { ok: true, facts: [] };
	}
}

/** A line of `plan`'s at `path`, standing as `state`, with `facts` and nothing under it. */
function line(plan: PlanLine, path: string, state: LiveState, facts: readonly string[] = []): LiveLine {
	return { kind: plan.kind, label: path, path, state, facts, subagents: [], lines: [] };
}

/** `plan` not visited yet, at `path`: its facts, its bound, and its lines, a `choice`'s cases folded to one. */
function pending(plan: PlanLine, path: string): LiveLine {
	const lines = plan.kind === "choice" ? [casesLine(path, plan.lines)] : plan.lines.map((one) => pending(one, path + one.path.slice(plan.path.length)));
	return { ...line(plan, path, "pending", plan.facts), ...(plan.bound !== undefined && { bound: plan.bound }), lines };
}

/** The one line the `cases` of the choice at `path` fold to, `lead` before their names. */
function casesLine(path: string, cases: readonly PlanLine[], lead = ""): LiveLine {
	return { kind: "cases", label: `${lead}${cases.map(caseLabel).join(", ")}`, path, state: "pending", facts: [], subagents: [], lines: [] };
}

function caseLabel(plan: PlanLine): string {
	return plan.id === "default" ? "default" : `case ${plan.id}`;
}

/** `2/3`: how many of `lines` are over, of `of`. */
function ended(lines: readonly LiveLine[], of: number): string {
	return `${lines.filter((one) => one.state === "done" || one.state === "failed").length}/${of}`;
}
