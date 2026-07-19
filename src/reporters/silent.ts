/**
 * The no-op reporter.
 *
 * It exists so that "no display" is a choice you can write down, rather than an
 * argument you forgot to pass. It is also what {@link autoReporter} falls back
 * to outside herdr.
 */

import type { EventListener } from "../events.ts";

export const silentReporter: EventListener = () => {};
