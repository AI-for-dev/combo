/**
 * The one thing the fake-session tests structurally cannot reach.
 *
 * Everything else here injects a `SessionPort` and never touches pi's real
 * module. That is what let a genuine bug through: `ModelRuntime` does not exist
 * in pi 0.80.6, so the extension - which runs inside pi's own process and
 * therefore resolves pi's own copy - died on `undefined.create()` while 158
 * tests stayed green.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildRegistry, type PiModule } from "../src/session.ts";

/** pi 0.80.7 and later: one ModelRuntime. */
const modern: PiModule = {
	ModelRuntime: { create: async () => ({ kind: "runtime" }) },
};

/** pi 0.80.6 and earlier: AuthStorage feeding a ModelRegistry. */
const legacy: PiModule = {
	AuthStorage: { create: () => ({ kind: "auth" }) },
	ModelRegistry: { create: (authStorage: unknown) => ({ kind: "registry", authStorage }) },
};

describe("buildRegistry", () => {
	test("uses ModelRuntime when pi exposes it", async () => {
		const registry = await buildRegistry(modern);

		assert.deepEqual(registry, { modelRuntime: { kind: "runtime" } });
		assert.ok(!("modelRegistry" in registry), "the two APIs must not be mixed");
	});

	test("falls back to AuthStorage + ModelRegistry on older pi", async () => {
		const registry = await buildRegistry(legacy);

		assert.deepEqual(registry, {
			authStorage: { kind: "auth" },
			modelRegistry: { kind: "registry", authStorage: { kind: "auth" } },
		});
		assert.ok(!("modelRuntime" in registry));
	});

	test("prefers ModelRuntime when a pi somehow exposes both", async () => {
		const registry = await buildRegistry({ ...modern, ...legacy });
		assert.ok("modelRuntime" in registry, "the newer API wins");
	});

	test("detects by presence, not by a version string", async () => {
		// A ModelRuntime export that is not callable is not a ModelRuntime.
		const broken = { ModelRuntime: {}, ...legacy } as PiModule;
		const registry = await buildRegistry(broken);
		assert.ok("modelRegistry" in registry, "an unusable export must not win the detection");
	});

	test("an unknown pi fails loudly, naming what it lacks", async () => {
		await assert.rejects(() => buildRegistry({}), /Unsupported pi version/);
		await assert.rejects(() => buildRegistry({}), /ModelRuntime nor AuthStorage/);
	});

	test("a half-present legacy API is not enough", async () => {
		await assert.rejects(() => buildRegistry({ AuthStorage: legacy.AuthStorage }), /Unsupported pi version/);
	});
});
