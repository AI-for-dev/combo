/**
 * The slash commands: one file per command, and the two helpers only one of
 * them uses - `commit.ts` for `/build`, `stage.ts` for `/step`.
 *
 * This is the directory's door. `index.ts` registers what is listed here;
 * `run.ts` in `ui/` reaches `watchRun` and `forgetRun` because a run has to
 * be known to `/stop` for as long as it lasts - the one arrow that goes from
 * the terminal into a command, and the sign that `stop.ts` holds a key and a
 * command at once.
 */

export { default as registerAgentCommands } from "./agents.ts";
export { default as registerBuildCommand } from "./build.ts";
export { default as registerHerdrCommand } from "./herdr.ts";
export { default as registerInterviewCommand } from "./interview.ts";
export { default as registerPipelineCommands, PIPELINE_MESSAGE } from "./pipeline.ts";
export { default as registerStepCommands } from "./step.ts";
export { default as registerStopCommand, forgetRun, watchRun } from "./stop.ts";
export { default as registerSwarmCommand } from "./swarm.ts";
