import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { toggleHerdr } from "../extension/commands/herdr.ts";
import { watchEverything, watchEverythingIs } from "../extension/ui/index.ts";
import { fakeCtx } from "./fixtures/command-ctx.ts";

// Outside herdr, whatever the environment the suite runs in: no probe is sent.
const outside = { detect: () => undefined };

describe("/herdr", () => {
	afterEach(() => watchEverythingIs(false));

	test("on and off set the switch", async () => {
		const { ctx } = fakeCtx();
		assert.equal(await toggleHerdr("on", ctx, outside), true);
		assert.equal(watchEverything(), true);
		assert.equal(await toggleHerdr(" OFF ", ctx, outside), false);
		assert.equal(watchEverything(), false);
	});

	test("a word other than on or off is refused, and the switch stays where it was", async () => {
		for (const word of ["all", "yes", "onn"]) {
			const { ctx, notes, said } = fakeCtx();
			assert.equal(await toggleHerdr(word, ctx, outside), false, word);
			assert.equal(watchEverything(), false, word);
			assert.equal(notes[0]?.type, "warning");
			assert.equal(said(), `herdr: takes on or off, not "${word}" - it is off`);
		}
	});
});
