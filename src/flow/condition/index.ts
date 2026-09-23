/**
 * A condition: a `choice` case's `when:`, a loop's `until` or its `give-up:`.
 *
 * A strict subset of CEL syntax, parsed here with no dependency, so every
 * expression it accepts is valid CEL and a real CEL library could replace this
 * module without breaking a file. Compiled once against the types of what it
 * may read, before the first spawn; evaluated at each visit against the
 * values.
 *
 * This is the module's door. The tree and the tokens are implementation.
 */

export { compileCondition, type Compiled, type Condition, type ConditionCode, type ConditionProblem, type Readable } from "./compile.ts";
export { evaluateCondition, type Evaluated } from "./evaluate.ts";
