/**
 * The slash commands: one file per command, and two helpers - `stage.ts` for
 * `/step`, and `answer.ts`, the message `/run` and `/quote` leave in the
 * conversation.
 *
 * This is the directory's door. `index.ts` registers what is listed here;
 * `run.ts` in `ui/` reaches `watchRun` and `forgetRun` because a run has to
 * be known to `/stop` for as long as it lasts - the one arrow that goes from
 * the terminal into a command, and the sign that `stop.ts` holds a key and a
 * command at once.
 */

export { default as registerAgentCommands } from "./agents.ts";
export { default as registerFlowsCommand } from "./flows.ts";
export { default as registerHerdrCommand } from "./herdr.ts";
export { default as registerInterviewCommand } from "./interview.ts";
export { RESULT_MESSAGE, type ResultDetails } from "./answer.ts";
export { default as registerRunCommand } from "./run.ts";
export { default as registerStepCommands } from "./step.ts";
export { default as registerStopCommand, forgetRun, watchRun } from "./stop.ts";
export { default as registerSwarmCommand } from "./swarm.ts";
