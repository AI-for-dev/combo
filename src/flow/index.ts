/**
 * A flow: a task graph written in YAML + Markdown, from a closed set of nodes,
 * validated whole before the first spawn and walked by our runner.
 *
 * This is the module's door. Nothing outside the library reaches it yet: the
 * format is built beside the linear pipeline, and the package exports it when
 * it replaces that. The file's reader, its nodes and its sections are
 * implementation: `loadFlowCatalogue` finds what a flow runs against, and
 * `checkFlow` is how a flow is read.
 */

export { loadFlowCatalogue, type FlowCatalogue } from "./catalogue.ts";
export { checkFlow, type CheckFlow } from "./check.ts";
export {
	ERROR_KINDS,
	LEDGER,
	STOPS,
	VERDICT,
	type CheckedAgentNode,
	type CheckedChoiceNode,
	type CheckedFlow,
	type CheckedLoopNode,
	type CheckedMapNode,
	type CheckedNode,
	type CheckedParallelNode,
	type CheckedRead,
} from "./checked.ts";
export {
	CONDITION_CODES,
	compileCondition,
	evaluateCondition,
	type Compiled,
	type Condition,
	type ConditionCode,
	type ConditionProblem,
	type Evaluated,
	type Readable,
} from "./condition/index.ts";
export { FAULT_CODES, type Fault, type FaultCode } from "./fault.ts";
export { QUESTION, readSchema, type ReadSchema, type SchemaProblem } from "./schema.ts";
export { showType, type Field, type ValueType } from "./type.ts";
