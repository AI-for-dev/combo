/**
 * What a command reaches for, and the real thing each one stands in for.
 *
 * The only bugs that ever reached a user through this extension were in the
 * wiring, and wiring is only testable when it can be handed doubles. So every
 * command takes its dependencies as an argument - and resolves them **once**,
 * here, rather than choosing between the double and the real thing at every
 * use. A command reads `deps.runPipeline` and never asks which it is.
 */

import {
	checkModel,
	createRunDir,
	interview,
	loadAgents,
	loadFlowCatalogue,
	loadPipelines,
	removedPipelines,
	run,
	runPipeline,
	swarm,
	type SpawnFn,
	type Verify,
} from "../src/index.ts";
import type { AppendEntry } from "./relay.ts";

/** Everything a command reaches for, injectable. Defaults are the real thing. */
export type CommandDeps = {
	loadAgents?: typeof loadAgents;
	/** Where the pipelines come from. Defaults to `~/.pi/agent/pipelines` and `.pi/pipelines`. */
	loadPipelines?: typeof loadPipelines;
	/** Where the flows and the agents they name come from: the package's, `~/.pi/agent/` and `.pi/`. */
	loadFlowCatalogue?: typeof loadFlowCatalogue;
	/** What is left in the old `pipelines/` directories, refused. */
	removedPipelines?: typeof removedPipelines;
	interview?: typeof interview;
	/** Runs a pipeline: `/step` uses it for a stage that names one. */
	runPipeline?: typeof runPipeline;
	/** Runs one throwaway agent: `/step` uses it for a stage that names one. */
	run?: typeof run;
	/** Puts several copies of one agent on one job: `/swarm`'s whole of the work. */
	swarm?: typeof swarm;
	/**
	 * The `spawn` a flow run's subagents come from, under the stop switch.
	 * Stays optional once resolved: absent is the real one, and a test hands
	 * sessions that answer as it scripted.
	 */
	spawn?: SpawnFn;
	/** Where transcripts land, and a flow run keeps its state. Defaults to a fresh `runs/<timestamp>/`. */
	runDir?: () => string;
	/**
	 * The project's own check. Stays optional once resolved: absent means
	 * nobody said, and the command decides what that means for it.
	 */
	verify?: Verify;
	/** Validates a `--model` pattern before anything runs. Touches the real pi. */
	checkModel?: typeof checkModel;
	/** Widget repaint period. `0` disables the timer - tests want that. */
	tickMs?: number;
};

/**
 * How a finished run reaches the conversation. Injected, so a test can catch it.
 *
 * A **custom** message, and not for want of trying: pi's extension API offers
 * exactly three doors into a conversation - `sendMessage` (custom, in the
 * model's context), `sendUserMessage` (a user message, and it always triggers a
 * turn) and `appendEntry` (drawn, but invisible to the model). There is no
 * assistant-message injection. A custom message is the only one that lands the
 * answer in context without launching a turn nobody asked for.
 */
export type SendMessage = (message: {
	customType: string;
	content: string;
	display: boolean;
	details?: unknown;
}) => void;

/**
 * {@link CommandDeps}, plus the door into the conversation that `/run` and
 * `/quote` use.
 *
 * The door is required, and nothing defaults it: a door that quietly did
 * nothing would be the failure this type exists to prevent - an answer
 * produced and never shown. pi's is bound in `sessionDoors`; a test hands a
 * recorder.
 */
export type MessageDeps = CommandDeps & { sendMessage: SendMessage };

/** {@link MessageDeps}, plus the door into the transcript that `/step` and `/swarm` use. Required, for the same reason. */
export type StepDeps = MessageDeps & { appendEntry: AppendEntry };

/**
 * {@link CommandDeps} with every gap filled: what a command actually runs with.
 *
 * `verify`, `spawn` and `tickMs` keep their optionality on purpose - for
 * them, absent is an answer and not a gap.
 */
export type Deps = Required<Omit<CommandDeps, "verify" | "spawn" | "tickMs">> & Pick<CommandDeps, "verify" | "spawn" | "tickMs">;

/**
 * Fills what the caller left unsaid with the real thing.
 *
 * A key holding `undefined` counts as unsaid: a caller that builds its deps by
 * merging hands us `{ runDir: undefined }` for an option nobody set, and an
 * explicit `undefined` spread over a default would silently win.
 */
export function resolved(deps: CommandDeps = {}): Deps {
	const said = Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined));
	return {
		loadAgents,
		loadPipelines,
		loadFlowCatalogue,
		removedPipelines,
		interview,
		runPipeline,
		run,
		swarm,
		runDir: () => createRunDir(),
		checkModel,
		...said,
	};
}
