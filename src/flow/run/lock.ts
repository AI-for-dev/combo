/**
 * One runner per run: `lock.json` in the run directory, made exclusively at
 * the start and at each resume, holding the pid and the host of the process
 * running it, and removed in a `finally`.
 *
 * Only a process on this host can be asked whether it is alive. A lock held
 * by a live one refuses with its pid; one whose process is gone was left by a
 * run that died, and is taken over. A lock from another host cannot be
 * judged from here, so it refuses with its path, to be removed by hand.
 *
 * Two takers can both find the same lock stale. A takeover is therefore made
 * holding `lock.json.takeover`, made exclusively too, which lets one taker
 * through at a time: it reads the lock again, and replaces it in one rename,
 * so the lock is never missing for another taker's exclusive make.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Where the lock is, in a run directory. */
export const LOCK_FILE = "lock.json";

/** What a lock holds. */
export type Held = {
	/** The process running the run. */
	readonly pid: number;
	/** The host that process runs on, the only one that can ask it whether it lives. */
	readonly host: string;
};

/** A lock taken: `release` removes it, once. */
export type Lock = { release(): void };

/**
 * Takes the lock of `runDir`, or says why it is not ours to take. `read` is
 * how a lock is read, a seam for a test to interleave another taker.
 */
export function takeLock(runDir: string, read: (file: string) => Held | undefined = heldBy): Lock | string {
	const file = join(runDir, LOCK_FILE);
	const takeover = `${file}.takeover`;
	const mine = `${JSON.stringify({ pid: process.pid, host: hostname() } satisfies Held)}\n`;
	const lock: Lock = { release: () => rmSync(file, { force: true }) };
	if (made(file, mine)) return lock;
	const stale = refusal(file, read(file));
	if (stale !== undefined) return stale;
	if (!made(takeover, mine)) return refusal(takeover, read(takeover)) ?? `the run's lock is being taken over through \`${takeover}\`: remove it by hand if nothing is taking it`;
	try {
		if (made(file, mine)) return lock;
		const still = refusal(file, read(file));
		if (still !== undefined) return still;
		const next = `${file}.next`;
		writeFileSync(next, mine);
		renameSync(next, file);
		return lock;
	} finally {
		rmSync(takeover, { force: true });
	}
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

/** Makes `file` holding `text` if nothing is there yet, and says whether it did. */
function made(file: string, text: string): boolean {
	try {
		writeFileSync(file, text, { flag: "wx" });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	}
}

/** Why the lock `file` holding `held` is not ours, or nothing when its process is gone. */
function refusal(file: string, held: Held | undefined): string | undefined {
	if (held === undefined || held.host !== hostname()) return `the run is locked by \`${file}\`${held === undefined ? "" : `, taken on ${held.host}`}: remove it by hand once nothing runs it`;
	if (alive(held.pid)) return `the run is already running, in process ${held.pid}`;
	return undefined;
}

/** What the lock at `file` holds, when it can be read. */
export function heldBy(file: string): Held | undefined {
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
