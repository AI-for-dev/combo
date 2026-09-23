/**
 * A flow: a task graph written in YAML + Markdown, from a closed set of nodes,
 * validated whole before the first spawn and walked by our runner.
 *
 * This is the module's door. Nothing outside the library reaches it yet: the
 * format is built beside the linear pipeline, and the package exports it when
 * it replaces that.
 */

export {
	compileCondition,
	evaluateCondition,
	type Compiled,
	type Condition,
	type ConditionCode,
	type ConditionProblem,
	type Evaluated,
	type Readable,
} from "./condition/index.ts";
export { showType, type Field, type ValueType } from "./type.ts";
