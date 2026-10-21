import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { piPackageUrl } from "../src/session.ts";

/**
 * The tarball `npm pack` builds, installed the two ways it is used.
 *
 * Every other test runs the sources from this clone, where node strips the
 * types and pi's packages sit in `node_modules`. Neither holds once the package
 * is installed: node refuses to strip types under `node_modules`, and
 * `pi install` leaves the peers out. Both broke the published package while
 * the whole suite stayed green.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const PEERS = ["@earendil-works", "typebox"];
let tmp: string;

/** `npm pack`, unpacked to `<where>/node_modules/@ai-for-dev/combo`. */
function install(where: string): string {
	const installed = path.join(where, "node_modules", "@ai-for-dev", "combo");
	fs.mkdirSync(installed, { recursive: true });
	const tarball = path.join(tmp, "combo.tgz");
	if (!fs.existsSync(tarball)) {
		const name = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], { cwd: ROOT, encoding: "utf8" }).trim().split("\n").pop() as string;
		fs.renameSync(path.join(tmp, name), tarball);
	}
	execFileSync("tar", ["-xzf", tarball, "-C", installed, "--strip-components=1"]);
	return installed;
}

/** Runs node on `args` in `cwd` until `done` matches what it wrote, or it exits. */
function run(cwd: string, args: string[], done: RegExp): Promise<string> {
	const child = spawn(process.execPath, args, { cwd });
	let out = "";
	return new Promise((resolve) => {
		const timer = setTimeout(() => child.kill(), 30_000);
		const take = (chunk: Buffer) => {
			out += chunk;
			if (done.test(out)) child.kill();
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("exit", () => {
			clearTimeout(timer);
			resolve(out);
		});
	});
}

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "combo-package-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the published package", () => {
	test("imports as a library from node_modules, with its types and its shipped agents", async () => {
		const project = path.join(tmp, "library");
		const installed = install(project);
		for (const peer of PEERS) fs.symlinkSync(path.join(ROOT, "node_modules", peer), path.join(project, "node_modules", peer));

		const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
		for (const file of [manifest.exports["."].types, manifest.exports["."].default, ...manifest.pi.extensions]) {
			assert.ok(fs.existsSync(path.join(installed, file)), `${file} is named in package.json but not in the tarball`);
		}

		// pi lists a package's extension by the package's name alone only when
		// its entry is `index.js` or `extensions/index.js`, and by a path beside
		// the name otherwise: `@ai-for-dev/combo:dist/extension`.
		assert.deepEqual(manifest.pi.extensions, ["./extensions/index.js"]);
		const entry = await run(project, ["--input-type=module", "-e", `const { default: load } = await import(${JSON.stringify(path.join(installed, "extensions", "index.js"))}); console.log(typeof load);`], /\n/);
		assert.equal(entry.trim(), "function", entry);

		const script = `const combo = await import("@ai-for-dev/combo"); console.log(JSON.stringify({ root: combo.PACKAGE_ROOT, agents: combo.loadAgents({ cwd: process.cwd(), builtin: true }).filter((agent) => agent.source === "builtin").map((agent) => agent.name) }));`;
		const out = await run(project, ["--input-type=module", "-e", script], /^\{.*\}\n/m);
		const { root, agents } = JSON.parse(out.slice(out.indexOf("{")));
		assert.equal(fs.realpathSync(root), fs.realpathSync(installed));
		assert.ok(agents.includes("scout"), `the shipped agents load from the package: ${agents.join(", ")}`);
	});

	test("starts a pane client from node_modules with no peers beside it, as pi installs it", async () => {
		const installed = install(path.join(tmp, "pi"));
		const pane = path.join(installed, "dist", "pane");
		const pi = piPackageUrl();
		const out = await run(
			tmp,
			["--import", path.join(pane, "peers.js"), path.join(pane, "main.js"), "--socket", path.join(tmp, "none.sock"), "--id", "scout#1", "--pi", pi],
			/ENOENT|ERR_/,
		);
		// Nothing listens on the socket: only a client that loaded can say so.
		assert.match(out, /ENOENT/, out);
		assert.doesNotMatch(out, /ERR_/, out);
	});
});
