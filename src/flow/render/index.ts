/**
 * The two renderings of a checked flow: its plan, as data and as text, and
 * a Mermaid `flowchart`. Both take a checked flow only, so a broken file is
 * never drawn: its faults are shown instead.
 *
 * This is the module's door.
 */

export { mermaidOf } from "./mermaid.ts";
export { planOf, type Plan, type PlanLine } from "./plan.ts";
export { showPlan } from "./text.ts";
