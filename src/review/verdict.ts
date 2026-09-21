/**
 * A verdict given as a tool call, rather than recovered from prose.
 *
 * A reviewer's answer is two things at once: an argument, which is prose and
 * belongs in the transcript, and a decision, which is a boolean and does not.
 * Reading the second out of the first means matching text written for a human
 * against a word chosen by a caller, and a match is only ever as good as the
 * agreement about how to write it.
 *
 * A tool call carries the decision on its own channel. It is a discrete event
 * with a schema, so "did it decide" and "what did it decide" are closed
 * questions, and the prose beside it stays prose.
 *
 * The tool is granted the way every tool is granted: an agent whose `tools:`
 * does not name it does not have it, which keeps what an agent can do readable
 * in its own file.
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../session.ts";
import { declares, refuse, said } from "../tool.ts";

/** The name an agent writes in its `tools:` to be given the tool. */
export const VERDICT_TOOL = "verdict";

/** What an agent said about one obligation it had raised. */
export type Resolution = {
	/** The obligation, by the id the ledger gave it. */
	id: string;
	/** `"addressed"` when the work was done, `"withdrawn"` when it is dropped. */
	how: "addressed" | "withdrawn";
	/** Why. A withdrawal without one is a silent drop. */
	reason?: string;
};

/** One decision, as the agent that made it declared it. */
export type Verdict = {
	/** Whether the agent has nothing further to ask. Never the last word on its own. */
	approved: boolean;
	/**
	 * Why, in the reviewer's own words. Required when `approved` is false.
	 *
	 * The reviewer's **argument** stays in its prose, which is what its
	 * definition disciplines and what the worker is sent. This is the short form
	 * it chose to attach to the decision, kept for whoever reads the outcome.
	 */
	remarks?: string;
	/** Obligations it says are done with, by id. Ones it does not name stay open. */
	resolved: Resolution[];
	/** New obligations it raises, as it wrote them. */
	raised: string[];
};

/** What a verdict tool needs to know beyond what the agent tells it. */
export type VerdictToolOptions = {
	/**
	 * Whether an id is one the agent may close right now.
	 *
	 * Without it every id is taken on trust. Measured with a small open-weight
	 * model: an auditor with nothing open sent `resolved: [{ id: "1" }]`,
	 * inventing both the line and the id format. Such an id is dropped from the
	 * verdict and named back to the agent, which keeps the ledger honest without
	 * costing the decision the same call carried.
	 */
	knows?: (id: string) => boolean;
	/** The ids it may close, named in the refusal so it can correct itself. */
	open?: () => readonly string[];
};

/** The tool, and the decisions it has collected so far. */
export type VerdictTool = {
	/** Pass this to `SpawnOptions.customTools`. */
	tool: ToolDefinition;
	/**
	 * The verdicts given since the previous call, oldest first, and forgets them.
	 *
	 * Draining rather than accumulating: a caller asks "what did *this* turn
	 * decide", and a persistent reviewer answers several times over its life.
	 */
	take(): Verdict[];
};

/**
 * Builds a `verdict` tool and the collector behind it.
 *
 * One per reviewer, never shared: the collector is how the decision gets back,
 * so two agents writing into one would make the answers indistinguishable.
 *
 * The tool body only records. It runs no check and reverses no decision, which
 * is what lets the caller treat what comes out of `take()` as exactly what the
 * agent said.
 */
export function verdictTool(options: VerdictToolOptions = {}): VerdictTool {
	const given: Verdict[] = [];

	const tool = defineTool({
		name: VERDICT_TOOL,
		label: "Verdict",
		description:
			"Give your decision on the work you were asked to review. Call this exactly once, " +
			"after you have read the code. Prose in your answer is not a decision: this call is. " +
			"Name in `resolved` every open obligation you are done with: one you do not name stays open.",
		promptSnippet: "Give your decision on the work under review",
		parameters: Type.Object({
			approved: Type.Boolean({ description: "true when you have nothing left to ask for." }),
			remarks: Type.Optional(
				Type.String({ description: "What is still missing. Required when approved is false." }),
			),
			resolved: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String({ description: "The obligation id, exactly as it was listed." }),
						how: Type.String({ description: '"addressed" when the work was done, "withdrawn" when you drop it.' }),
						reason: Type.Optional(Type.String({ description: "Why. Required for a withdrawal." })),
					}),
					{ description: "Open obligations you are done with. One you leave out stays open." },
				),
			),
			raised: Type.Optional(
				Type.Array(Type.String(), { description: "New things that must happen, one per entry." }),
			),
		}),
		async execute(_toolCallId, params) {
			// Absent and empty are the same thing: a model asked for an optional
			// string often sends `""` rather than leaving it out.
			const remarks = params.remarks?.trim() || undefined;
			// A refusal that says nothing cannot be acted on, and the agent is the
			// only one who can repair it - so it is told, and gets to call again.
			if (!params.approved && !remarks && !(params.raised ?? []).length) {
				return refuse("A verdict of `approved: false` needs remarks, or something raised. Call again with them.");
			}

			// A `how` the schema allows but the type does not is dropped rather than
			// guessed: closing an obligation the wrong way is worse than not closing
			// it, and an unclosed one is visible while a mis-closed one is not.
			const resolved: Resolution[] = [];
			for (const one of params.resolved ?? []) {
				if (one.how !== "addressed" && one.how !== "withdrawn") continue;
				resolved.push({ id: one.id.trim(), how: one.how, reason: one.reason?.trim() || undefined });
			}

			// An id nobody raised closes nothing, here or in the ledger, so there is
			// nothing left to protect by throwing the decision away with it. What
			// that cost was measured: an auditor with nothing open sent
			// `resolved: [{ id: "coder" }]` beside `approved: true`, was refused,
			// sent the same id again, was refused again, and the delivery ended
			// unapproved over bookkeeping while its decision had been given twice.
			const known = options.knows ? resolved.filter((one) => options.knows?.(one.id)) : resolved;
			const unknown = resolved.filter((one) => !known.includes(one)).map((one) => one.id);
			const raised = (params.raised ?? []).map((one) => one.trim()).filter(Boolean);

			given.push({ approved: params.approved, remarks, resolved: known, raised });

			const recorded = params.approved ? "Recorded: approved." : "Recorded: not approved.";
			if (unknown.length === 0) return said(recorded);

			// Said rather than hidden, and in the same breath as the decision: the
			// agent learns its bookkeeping was wrong without learning that its
			// answer was thrown away.
			const open = options.open?.() ?? [];
			return said(
				`${recorded} Nothing was closed for ${unknown.join(", ")}: no obligation has that id. ${
					open.length ? `The ids you may close: ${open.join(", ")}.` : "Nothing is open."
				}`,
			);
		},
	});

	return {
		tool,
		take: () => given.splice(0),
	};
}

/** Whether an agent's definition asks for the tool. */
export function declaresVerdict(tools: readonly string[] | undefined): boolean {
	return declares(tools, VERDICT_TOOL);
}
