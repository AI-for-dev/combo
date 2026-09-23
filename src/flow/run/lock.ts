/**
 * One runner per run: `lock.json` in the run directory, made exclusively at
 * the start and at each resume, holding the pid and the host of the process
 * running it, and removed in a `finally`.
 *
 * Only a process on this host can be asked whether it is alive. A lock held
 * by a live one refuses with its pid; one whose process is gone was left by a
 * run that died, and is taken over. A lock from another host cannot be
 * judged from here, so it refuses with its path, to be removed by hand.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Where the lock is, in a run directory. */
export const LOCK_FILE = "lock.json";

/** What a lock holds. */
type Held = { readonly pid: number; readonly host: string };

/** A lock taken: `release` removes it, once. */
export type Lock = { release(): void };

/** Takes the lock of `runDir`, or says why it is not ours to take. */
export function takeLock(runDir: string): Lock | string {
	const file = join(runDir, LOCK_FILE);
	const mine: Held = { pid: process.pid, host: hostname() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(file, `${JSON.stringify(mine)}\n`, { flag: "wx" });
			return { release: () => rmSync(file, { force: true }) };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const held = heldBy(file);
		if (held === undefined || held.host !== mine.host) return `the run is locked by \`${file}\`${held === undefined ? "" : `, taken on ${held.host}`}: remove it by hand once nothing runs it`;
		if (alive(held.pid)) return `the run is already running, in process ${held.pid}`;
		// Its process died without its `finally`: the lock is stale, and ours to take.
		rmSync(file, { force: true });
	}
	return `the run is locked by \`${file}\`, taken again as it was being taken over`;
}

/**
 * Runs `run` holding the lock of `runDir`, released however it ends; or
 * hands `refused` why the lock is not ours.
 */
export async function whileLocked<T>(runDir: string, refused: (why: string) => T, run: () => Promise<T>): Promise<T> {
	const lock = takeLock(runDir);
	if (typeof lock === "string") return refused(lock);
	try {
		return await run();
	} finally {
		lock.release();
	}
}

/** What the lock at `file` holds, when it can be read. */
function heldBy(file: string): Held | undefined {
	try {
		const held = JSON.parse(readFileSync(file, "utf-8")) as Partial<Held>;
		return typeof held.pid === "number" && typeof held.host === "string" ? { pid: held.pid, host: held.host } : undefined;
	} catch {
		return undefined;
	}
}

/** Whether the process `pid` of this host is running. One we may not signal is running too. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
