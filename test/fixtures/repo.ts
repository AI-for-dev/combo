/**
 * A throwaway git repository in a temporary directory, for the flow nodes
 * that act on one. git is local, so this needs no network, and a mocked git
 * would prove nothing about the tree a run leaves behind.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const made: string[] = [];
after(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A repository with one commit holding `README.md`, then `files` written and left uncommitted. */
export function repository(files: Record<string, string> = {}): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "combo-flow-git-")));
	made.push(dir);
	git(dir, "init", "--initial-branch=main");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-m", "first");
	write(dir, files);
	return dir;
}

/** Writes each of `files` under `dir`, making the directories they need. */
export function write(dir: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
}

/** Runs git in `dir`, and hands back what it printed, trimmed. */
export function git(dir: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: "pipe" }).trim();
}

/** A directory that is no repository. */
export function plainDirectory(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "combo-flow-plain-"));
	made.push(dir);
	return dir;
}
