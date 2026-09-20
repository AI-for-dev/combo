/**
 * What every combinator shares: the same options, under the same names, with
 * the same defaults.
 *
 * Combinators are functions, not classes. No inheritance, no global registry.
 * They compose because they all take a `Result` in and give a `Result` back.
 */

import type { Agent, Lifetime } from "./../agent.ts";
import type { EventBus, EventListener } from "./../events.ts";
import type { ToolDefinition } from "./../session.ts";
import type { CustomToolsFor, SpawnOptions, Subagent } from "./../subagent.ts";

/** The spawn function a combinator uses. Injection point for tests. */
export type SpawnFn = (agent: Agent, options: SpawnOptions) => Promise<Subagent>;

/** Options common to every workflow - same names, same defaults, everywhere. */
export type WorkflowOptions = {
	/** Defaults to `"task"`. Persistence is asked for, never assumed. */
	lifetime?: Lifetime;
	/** Propagated down to every `session.prompt()`, and closes open sessions. */
	signal?: AbortSignal;
	/**
	 * Deadline **per turn**, not for the whole workflow. No default.
	 *
	 * A chain of five steps with `timeoutMs: 60_000` can legitimately run for
	 * five minutes; what it cannot do is hang forever on one of them. See
	 * {@link AskOptions.timeoutMs} for why that guard is needed at all.
	 */
	timeoutMs?: number;
	/** A single listener for the whole workflow. Compose with {@link combineReporters}. */
	onEvent?: EventListener;
	/** Report onto an existing bus instead of a private one - the extension's case. */
	bus?: EventBus;
	/** Working directory of every subagent. Defaults to the process's own. */
	cwd?: string;
	/** Where the session files live. Implied by `exportDir`; set it to move them. */
	sessionDir?: string;
	/**
	 * Where every subagent of this workflow writes its transcript when it
	 * closes. See {@link SpawnOptions.exportDir}: it implies a session
	 * directory, and it is opt-in.
	 *
	 * Because the pool closes in a `finally`, an interrupted workflow still
	 * exports what it managed to do.
	 */
	exportDir?: string;
	/** Give every subagent of this workflow its own herdr split. Opt-in. */
	openInHerdr?: boolean;
	/**
	 * Model pattern for **every** subagent of this workflow.
	 *
	 * An override, like {@link SpawnOptions.model}, and for the same reason: it
	 * is what lets one workflow run against different models without touching an
	 * agent file. It beats every agent's frontmatter - a sweep that let a pinned
	 * agent through would measure a mixture.
	 */
	model?: string;
	/** Defaults to the real {@link spawn}. */
	spawn?: SpawnFn;
	/**
	 * Tools combo defines, chosen per agent.
	 *
	 * A function rather than a list, because the answer differs by agent: a
	 * reviewer is offered the verdict tool and the worker beside it is not, and
	 * a collector shared between two agents could not say which of them spoke.
	 *
	 * Returning a {@link CustomToolsFor} instead of a list defers the choice one
	 * step further, to the moment the subagent's id exists - see
	 * {@link SpawnOptions.customTools}. The pool passes either through untouched:
	 * only a tool that spawns children needs the id, and nothing else should pay
	 * for it.
	 */
	customTools?: (agent: Agent) => ToolDefinition[] | CustomToolsFor | undefined;
	/**
	 * The subagent every subagent of this workflow hangs under.
	 *
	 * Set when a workflow is itself the work of a subagent, which today means
	 * `delegateTool`. It is what turns a flat list of measurements into a tree.
	 */
	parentId?: string;
};
