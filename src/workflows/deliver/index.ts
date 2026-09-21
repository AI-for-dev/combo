/**
 * The delivery: a plan, pairs that code and review it, an audit of the whole,
 * and the two things only a delivery needs - how its work reaches the tree,
 * and how a run of it is saved and picked up again.
 *
 * This is the module's door. What is listed here is what the rest of the
 * library and the public surface may reach; `settle.ts` is not, because the
 * delivery is the one caller that asks how its copies come home.
 */

export { audit, type AuditOptions, type AuditProgress, type AuditPromptOptions, type AuditResult, type AuditRound, type Fixed } from "./audit.ts";
export { deliver, type BuildProgress, type DeliverOptions, type DeliverResult } from "./deliver.ts";
export { APPROVAL, pair, type PairOptions, type PairResult } from "./pair.ts";
export {
	BUILD_STATE_VERSION,
	findResumableBuild,
	fromBuildState,
	missingAgents,
	saveBuildState,
	toBuildState,
	type BuildState,
} from "./resume.ts";
export { type SettleOptions, type Settling } from "./settle.ts";
