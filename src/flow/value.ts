/**
 * The values a flow's keys hold, each read to one type or refused.
 *
 * Every key has one type, so a value that is not of it is a fault rather than
 * a coercion: `retry: "2"` was written by someone who meant something, and
 * guessing what is how a flow ends up running a way its file does not say.
 */

import type { FaultList } from "./fault.ts";

const DURATION = /^([1-9][0-9]*)(s|m|h)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/** A non-empty string. */
export function text(value: unknown, at: string, faults: FaultList): string | undefined {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	faults.add("key-type", at, "takes a non-empty string");
	return undefined;
}

/** A whole number, zero or more. */
export function count(value: unknown, at: string, faults: FaultList): number | undefined {
	if (Number.isInteger(value) && (value as number) >= 0) return value as number;
	faults.add("key-type", at, "takes a whole number, zero or more");
	return undefined;
}

/** A duration written `90s`, `10m` or `1h`, in milliseconds. */
export function duration(value: unknown, at: string, faults: FaultList): number | undefined {
	const match = typeof value === "string" ? DURATION.exec(value.trim()) : null;
	if (match) return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
	faults.add("key-type", at, "takes a duration written `90s`, `10m` or `1h`");
	return undefined;
}

/** A list of non-empty strings, none twice. */
export function texts(value: unknown, at: string, faults: FaultList): string[] | undefined {
	const items = Array.isArray(value) ? value : undefined;
	if (items === undefined || items.some((item) => typeof item !== "string" || item.trim() === "")) {
		faults.add("key-type", at, "takes a list of names, as in `[plan, review]`");
		return undefined;
	}
	const trimmed = items.map((item: string) => item.trim());
	const twice = trimmed.filter((item, i) => trimmed.indexOf(item) !== i);
	if (twice.length === 0) return trimmed;
	faults.add("key-type", at, `names ${twice.map((item) => `\`${item}\``).join(", ")} twice`);
	return undefined;
}

/** One of a closed set of words. */
export function oneOf<T extends string>(value: unknown, words: readonly T[], at: string, faults: FaultList): T | undefined {
	if (typeof value === "string" && (words as readonly string[]).includes(value)) return value as T;
	faults.add("key-type", at, `takes ${words.map((word) => `\`${word}\``).join(" or ")}`);
	return undefined;
}

/** `true` or `false`, written as such. */
export function flag(value: unknown, at: string, faults: FaultList): boolean | undefined {
	if (typeof value === "boolean") return value;
	faults.add("key-type", at, "takes `true` or `false`");
	return undefined;
}
