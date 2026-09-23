/**
 * The renderings of a checked flow: its plan, as data and as text, a Mermaid
 * `flowchart`, and the live view of a run, its plan filled from the journal
 * and the event stream. Each takes a checked flow only, so a broken file is
 * never drawn: its faults are shown instead.
 *
 * This is the module's door.
 */

export { livePlan, type LiveLine, type LivePlan, type LiveState } from "./live.ts";
export { showLive, showSummary } from "./live-text.ts";
export { mermaidOf } from "./mermaid.ts";
export { planOf, type Plan, type PlanLine } from "./plan.ts";
export type { LiveSummary } from "./summary.ts";
export { showPlan } from "./text.ts";
