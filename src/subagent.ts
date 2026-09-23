/**
 * A subagent: a live session, a memory, a state.
 *
 * This is the heart of the library. Everything else - `run`, `chain`,
 * `fanOut` - is built on the three methods below: `ask`, `usage`, `close`.
 *
 * The rule that governs this file: **whoever opens, closes**. A `Subagent` is
 * an explicit object with an explicit owner. There is no global session cache
 * hidden anywhere.
 */

import path from "node:path";
import type { Agent, Lifetime } from "./agent.ts";
import { busFor, nextSubagentId, type EventBus, type EventListener, type SubagentEvent } from "./events.ts";
import { exportBaseName, exportSession, type SessionExport } from "./measure/index.ts";
import { inTheLanguageOfTheWork } from "./language.ts";
import { registerMirror } from "./mirror.ts";
import { failed, succeeded, type Result } from "./result.ts";
import {
	createDefaultSession,
	lastTurn,
	modelLabel,
	streamed,
	type CreateSession,
	type SessionPort,
	type ToolDefinition,
} from "./session.ts";
import { accumulate, deltaUsage, emptyUsage, snapshotUsage, type Usage } from "./usage.ts";

/**
 * Tools built once the subagent's id is known.
 *
 * The one thing a caller cannot decide before `spawn`: a tool that spawns
 * children has to name their parent, and the parent does not exist yet.
 */
export type CustomToolsFor = (id: string) => ToolDefinition[] | undefined;

/**
 * What an offer amounts to for the subagent about to get `id`.
 *
 * The one reader of {@link SpawnOptions.customTools}'s two shapes: `spawn`
 * reads through it, and so does anything that composes two offers or asserts
 * on one. A list is a list; a function is asked, now that the id exists.
 */
export function toolsOffered(offer: SpawnOptions["customTools"], id: string): ToolDefinition[] {
	return (typeof offer === "function" ? offer(id) : offer) ?? [];
}

/** Everything that can be decided about a subagent before it exists. */
export type SpawnOptions = {
	/** Overrides the lifetime declared by the agent. Defaults to `"task"`. */
	lifetime?: Lifetime;
	/** Working directory the subagent's tools act in. Defaults to the process's own. */
	cwd?: string;
	/** Dedicated session directory, required for the session to be exportable. */
	sessionDir?: string;
	/**
	 * Where this subagent writes its HTML and JSONL when it closes.
	 *
	 * Setting it **implies a session directory** (`<exportDir>/.sessions`),
	 * because pi cannot render an in-memory session to HTML. That is one
	 * decision, not two: asking for an export is asking for the session to be
	 * kept long enough to export it. Pass {@link SpawnOptions.sessionDir}
	 * explicitly to put it somewhere else.
	 *
	 * Still opt-in: with no `exportDir`, a subagent stays in memory and leaves
	 * nothing behind - not in `~/.pi`, not in the working directory.
	 */
	exportDir?: string;
	/** The name its files take in `exportDir`, without the extension. Defaults to its id's, `reviewer-2`. */
	exportName?: string;
	/** Subscribed to the event stream for the subagent's whole life. */
	onEvent?: EventListener;
	/** Shared bus, when several subagents must report to the same place. */
	bus?: EventBus;
	/** Session factory. Injection point for tests - defaults to a real pi session. */
	createSession?: CreateSession;
	/**
	 * Tools combo defines, offered to this subagent.
	 *
	 * Offered, not granted: the agent's `tools:` is an allowlist and covers these
	 * too, so one it does not name is not enabled. See
	 * {@link CreateSessionOptions.customTools}.
	 *
	 * A function receives the id this subagent is about to get, before its
	 * session opens. That is what a tool spawning children needs in order to
	 * name their parent, and it is the only way to have it: the id is minted
	 * here, after the caller has built everything it could.
	 */
	customTools?: ToolDefinition[] | CustomToolsFor;
	/**
	 * The subagent that had this one spawned, when one did.
	 *
	 * Set by `delegateTool`, never guessed: a name is ambiguous the moment two
	 * explorers run at once, so the link is an id or it is nothing. It reaches
	 * the reporters on the `spawn` event and nothing else reads it.
	 */
	parentId?: string;
	/** The flow visit this subagent is spawned for. It reaches the reporters on the `spawn` event. */
	visit?: string;
	/** Where a flow keeps it: its memory scope's path, else its visit's. It reaches the reporters on the `spawn` event. */
	home?: string;
	/**
	 * Model pattern for this subagent, e.g. `"anthropic/claude-sonnet-5"`.
	 *
	 * An override, not a default: the argument wins over the agent's
	 * frontmatter, which wins over pi's own settings - the same rule as
	 * {@link SpawnOptions.lifetime}. It exists so one workflow can run against
	 * different models without editing a single agent file; a frontmatter model
	 * surviving a sweep would make an experiment measure a mixture.
	 *
	 * A pattern that resolves to nothing throws at spawn: better than running
	 * a whole workflow on the wrong model.
	 */
	model?: string;
	/**
	 * Give this subagent its own herdr split, when running inside herdr.
	 *
	 * Opt-in per subagent, like {@link SpawnOptions.lifetime}, and resolved the
	 * same way: this argument wins over the agent's frontmatter, which wins over
	 * `false`. A fan-out of twenty branches must not carpet the screen unless
	 * someone asked for it. Outside herdr it is simply ignored.
	 */
	openInHerdr?: boolean;
};

/** What governs one turn: how it can be stopped, and when it must be. */
export type AskOptions = {
	/**
	 * Cancels this turn. pi's `prompt()` takes no signal, so we bridge it to
	 * `session.abort()`.
	 */
	signal?: AbortSignal;
	/**
	 * Deadline for this turn, in milliseconds. No default: an `ask` waits
	 * forever unless you say otherwise.
	 *
	 * This matters more than it looks. One `ask` is one `session.prompt()`, and
	 * pi's agent loop is a `while (true)` that runs as long as the model keeps
	 * requesting tools - there is no step cap in pi. A model that hallucinates a
	 * tool name, gets "unknown tool" back and asks again will loop until
	 * something stops it. Nothing will, unless it is this.
	 */
	timeoutMs?: number;
};

/** A living subagent. Its owner is whoever called {@link spawn}. */
export type Subagent = {
	/** Unique for the process, e.g. `reviewer#2`. Names its transcript files. */
	readonly id: string;
	/** The definition it was spawned from. Inert data - it is not re-read. */
	readonly agent: Agent;
	/** Resolved once, at spawn: the argument, then the frontmatter, then `"task"`. */
	readonly lifetime: Lifetime;
	/** `provider/id` as pi resolved it, which only the session knows. Absent when pi could not say. */
	readonly model?: string;
	/** Cumulative measurements since spawn. Read `Result.usage` for a single turn. */
	readonly usage: Usage;
	/** Runs one turn of work. Never throws on a model failure - returns `ok: false`. */
	ask(task: string, options?: AskOptions): Promise<Result>;
	/**
	 * Stops this subagent, for good: the turn in flight is cut short, and any
	 * later `ask` fails at once with `"stopped"`.
	 *
	 * One-way and idempotent, because that is what a person pressing a key
	 * means. It is **not** `close()`: the session is still there, so the
	 * transcript of what it did before it was stopped is still exportable, and
	 * whoever opened it still owes it a `close()`.
	 */
	stop(): void;
	/**
	 * Writes this subagent's transcript into `dir` - HTML and JSONL, pi's own.
	 *
	 * Callable at any moment while the subagent lives, not only at the end: an
	 * interrupted workflow must still be able to export what it did. After
	 * `close()` the session is gone, so this reports an error instead of
	 * throwing - losing an export must never be worse than losing the run.
	 */
	export(dir?: string): Promise<SessionExport>;
	/** Releases the session. Idempotent. */
	close(): Promise<void>;
};

/**
 * Brings an agent to life.
 *
 * The lifetime is **explicit and local**: the argument wins over the agent's
 * frontmatter, which itself wins over the `"task"` default. Persistence is
 * asked for; it is never obtained by accident.
 *
 * The caller owns the returned object and must `close()` it, ideally in a
 * `finally`.
 */
export async function spawn(agent: Agent, options: SpawnOptions = {}): Promise<Subagent> {
	const lifetime = options.lifetime ?? agent.lifetime ?? "task";
	const { id, order } = nextSubagentId(agent.name);

	const bus = busFor(options);

	const createSession = options.createSession ?? createDefaultSession;
	// Asking for an export is asking for a session on disk: pi refuses to render
	// an in-memory one. `.sessions` keeps those working files out of the way of
	// the exports themselves, which are what a human opens.
	const sessionDir = options.sessionDir ?? (options.exportDir ? path.join(options.exportDir, ".sessions") : undefined);
	// The model is resolved here, once, like the lifetime: the fake session a
	// test injects sees the *effective* pattern, not the ladder that chose it.
	const session = await createSession(agent, {
		cwd: options.cwd,
		sessionDir,
		model: options.model ?? agent.model,
		customTools: toolsOffered(options.customTools, id),
	});

	const model = modelLabel(session);
	// Monotonic clock: `Date.now()` jumps when the system clock is adjusted,
	// and a duration must never go backwards.
	const spawnedAt = performance.now();
	let usage: Usage = emptyUsage();
	// This subagent's own stop switch, apart from the caller's signal: stopping
	// one branch must not touch the ones beside it.
	const stopper = new AbortController();
	// Reachable from a pane, by id, while it lives: the transcript to look at,
	// the turn in flight to speak to, and the stop switch.
	const unregister = registerMirror({
		id,
		agent: agent.name,
		model,
		cwd: options.cwd ?? process.cwd(),
		session,
		bus,
		stop: () => stopper.abort(),
	});
	let closed = false;
	let asking = false;
	/**
	 * How the last turn ended, so `close()` can say so.
	 *
	 * Without it `close()` announced `ok: true` unconditionally, and every
	 * reporter reading the `close` event drew a green tick on a subagent that had
	 * just failed - a 402 from the provider showed up as `✓ explorer#1`, with an
	 * empty output nobody had a reason to look at. The verdicts were never wrong,
	 * because a workflow reads the `Result` from `ask()`; only the display lied,
	 * which is the one place a lie is not caught by anything downstream.
	 *
	 * The **last** turn and not "any turn ever": a persistent subagent that
	 * failed a turn and then recovered is working, and `status: blocked` / `idle`
	 * already follows the same rule turn by turn.
	 */
	let lastError: string | undefined;

	// Streaming events are forwarded as they arrive - never buffered until the
	// end of the turn, otherwise the TUI would show an opaque spinner.
	const unsubscribe = session.subscribe((event) => {
		const seen = streamed(event);
		if (seen?.type === "text") bus.emit({ type: "text", id, delta: seen.delta });
		else if (seen?.type === "tool") bus.emit({ type: "tool", id, name: seen.name, args: seen.args });
	});

	const openInHerdr = options.openInHerdr ?? agent.openInHerdr ?? false;
	bus.emit({
		type: "spawn",
		id,
		agent: agent.name,
		lifetime,
		openInHerdr,
		order,
		model,
		parentId: options.parentId,
		visit: options.visit,
		home: options.home,
		...(options.exportDir !== undefined && { transcript: path.join(options.exportDir, options.exportName ?? exportBaseName(id)) }),
	});
	bus.emit({ type: "status", id, status: "idle" });

	const subagent: Subagent = {
		id,
		agent,
		lifetime,
		model,
		get usage() {
			// Wall time keeps running between two `ask` calls: on a persistent
			// agent, the gap between wallMs and busyMs *is* the information.
			return { ...usage, wallMs: performance.now() - spawnedAt };
		},

		async ask(task, askOptions = {}) {
			// Asking a closed subagent is a programming error, not a runtime
			// failure: it must not be swallowed into a failed Result.
			if (closed) throw new Error(`Subagent ${id} is closed: ask() is no longer allowed`);
			if (asking) throw new Error(`Subagent ${id} is already working: ask() calls must be serialised`);
			asking = true;

			const before = readUsage(session);
			const startedAt = performance.now();
			const startIndex = session.messages.length;

			// One signal to watch, whether it comes from this subagent's own stop
			// switch, from the caller, or from the deadline. The timeout is created
			// here so it starts with the turn.
			const timeout = askOptions.timeoutMs ? AbortSignal.timeout(askOptions.timeoutMs) : undefined;
			const signal = combineSignals(stopper.signal, askOptions.signal, timeout);

			// A signal that has *already* aborted never fires again, so a listener
			// added now would never run: the turn has to be refused outright, or a
			// stopped subagent would go on to do a whole turn of work.
			let error: string | undefined = signal.aborted ? "aborted" : undefined;

			// The listener is removed in the `finally`: a signal shared across
			// several `ask` calls would otherwise accumulate listeners.
			const onAbort = () => void session.abort();
			signal.addEventListener("abort", onAbort, { once: true });

			bus.emit({ type: "status", id, status: "working", task });

			let reached = false;
			try {
				if (!error) {
					reached = true;
					// The language rule closes the turn as well as standing behind it:
					// what a combinator frames the work with is English, and it arrives
					// in this very message. See `src/language.ts`.
					await session.prompt(inTheLanguageOfTheWork(task));
				}
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
			} finally {
				signal.removeEventListener("abort", onAbort);
				asking = false;
			}

			const busyMs = performance.now() - startedAt;
			const turn = deltaUsage(before, readUsage(session));
			turn.busyMs = busyMs;
			// Even a failed turn counts: a subagent that died after 12k tokens did
			// spend 12k tokens. A **refused** one does not: a subagent stopped
			// before this call never reached the session, so there was no request,
			// no answer and nothing to count. Reporting it as a turn is the one
			// kind of number invariant 9 forbids - one nobody measured.
			turn.turns = reached ? 1 : 0;

			usage = accumulate(usage, turn);

			const messages = session.messages.slice(startIndex);
			// A turn can also fail without throwing: pi reports it through the
			// last assistant message, and the session's reader says so.
			const said = lastTurn(messages);
			error ??= said.error;

			// All three look like an abort from pi's side. Say which one it was: a
			// deadline that expired, a caller that changed its mind and a person who
			// pressed a key call for very different reactions. The most specific
			// cause wins, and a person asking is as specific as it gets.
			if (error && stopper.signal.aborted) {
				error = "stopped";
			} else if (error && timeout?.aborted && !askOptions.signal?.aborted) {
				error = `timed out after ${askOptions.timeoutMs}ms`;
			}

			const result: Result = error ? failed(agent.name, error, turn, messages) : succeeded(agent.name, said.text, turn, messages);

			lastError = error;
			bus.emit({ type: "usage", id, usage: turn });
			bus.emit({ type: "status", id, status: error ? "blocked" : "idle" });
			return result;
		},

		stop() {
			stopper.abort();
		},

		async export(dir = options.exportDir) {
			if (!dir) return { id, error: "no export directory: pass one, or spawn with exportDir" };
			if (closed) return { id, error: `Subagent ${id} is closed: its session is gone` };
			return exportSession(session, dir, id, options.exportName);
		},

		async close() {
			if (closed) return;

			// Exporting happens while the session is still alive - and before
			// `closed` is set, so this is the same path a caller would take.
			if (options.exportDir) await subagent.export(options.exportDir);
			closed = true;

			// Stats and context are read *before* dispose(): afterwards the
			// session is gone and the numbers with it.
			const finalUsage = { ...usage, wallMs: performance.now() - spawnedAt };
			unsubscribe();
			session.dispose();

			bus.emit({ type: "status", id, status: "done" });
			bus.emit({
				type: "close",
				id,
				// Over the subagent's whole life, and without the messages: what a
				// reader wants of a close is the outcome and the bill, and the
				// transcript is the export's.
				result: lastError ? failed(agent.name, lastError, finalUsage) : succeeded(agent.name, lastTurn(session.messages).text, finalUsage),
			});
			unregister();
		},
	};

	return subagent;
}

/**
 * Merges the stop switch with the caller's signal and the deadline, when there
 * are any.
 *
 * Returns `first` itself when it is alone, so no needless `AbortSignal.any`
 * wrapper is created on the common path.
 */
function combineSignals(first: AbortSignal, ...rest: (AbortSignal | undefined)[]): AbortSignal {
	const present = rest.filter((signal): signal is AbortSignal => signal !== undefined);
	if (present.length === 0) return first;
	return AbortSignal.any([first, ...present]);
}

/** Reads the session counters. Never lets a broken provider bring a turn down. */
function readUsage(session: SessionPort): Usage {
	try {
		return snapshotUsage(session.getSessionStats());
	} catch {
		return emptyUsage();
	}
}

export type { SubagentEvent };
