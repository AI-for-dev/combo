/**
 * The review record: what one reviewer decided, and what it is still owed.
 *
 * A review is two things read together - a decision, which `verdict.ts`
 * carries as a tool call, and a list of things that must happen, which
 * `ledger.ts` keeps - and `review.ts` is the one place that joins them. This
 * is the module's door, and it lists that one function, the types a result
 * names, `createLedger` for a list several records share, as a flow's scope
 * does, and the tool's name for an allowlist to hold. The tool itself is not
 * on it: the record is its only reader.
 */

export { createLedger, type Closure, type CloseOutcome, type Ledger, type Obligation } from "./ledger.ts";
export { reviewRecord, type ProseApproval, type ReviewRecord, type ReviewRecordOptions, type ReviewRound } from "./review.ts";
export { VERDICT_TOOL, type Resolution, type Verdict, type VerdictTool } from "./verdict.ts";
