/**
 * Checking the nodes that act on the world, where the flow stage can say
 * something about them. A `check` has nothing to resolve: whether its script
 * is there is the run stage's. A `commit` reads its message, and says where
 * it may not stand.
 */

import type { CheckedOne, Checker } from "./check.ts";
import type { CheckedCommitNode } from "./checked.ts";
import type { CommitNode } from "./node.ts";
import type { Scope } from "./scope.ts";
import { showType } from "./type.ts";

/** A commit's message is an earlier node's text, and a branch's copy is not where it commits. */
export function checkCommit(checker: Checker, node: CommitNode, scope: Scope): CheckedOne["node"] {
	const at = `${node.at}.commit`;
	const before = checker.faults.list.length;
	if (scope.inCopies()) {
		checker.faults.add("commit-in-copies", at, "a commit in a branch's copy would break the patch that brings the branch home: commit after the block");
	}
	const root = node.message.split(".")[0] ?? "";
	if (!checker.isNode(root) && scope.has(root)) {
		checker.faults.add("key-type", at, `\`${node.message}\`: a commit's message is an earlier node's output, as \`message\` or \`message.output.text\``);
	} else {
		const read = checker.read(node.message, at, scope);
		if (read !== undefined && read.type.kind !== "text" && read.type.kind !== "string") {
			checker.faults.add("key-type", at, `\`${node.message}\` is ${showType(read.type)}; a commit's message is a text`);
		}
	}
	if (checker.faults.list.length > before) return undefined;
	const { id, continueOnFail, message } = node;
	return { kind: "commit", id, at: node.at, continueOnFail, message } satisfies CheckedCommitNode;
}
