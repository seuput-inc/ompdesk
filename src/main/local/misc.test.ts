import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import { handlers } from "./misc";
import type { LocalCommandContext } from "./types";

async function fixture(source: string) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omp facts ")));
	onTestFinished(() => rmSync(cwd, RM_TEMP));
	const bin = await writeFakeOmp(cwd, source);
	const unused = async (): Promise<never> => {
		throw new Error("unexpected call outside native omp");
	};
	const ctx: LocalCommandContext = {
		cwd,
		omp: { bin, basePath: process.env.PATH ?? "", version: "18.6.1", run: unused },
		bridge: { connected: false, request: unused },
		send: unused,
	};
	return { cwd, call: (type: string) => handlers[type]({ type, args: ["update"] }, ctx) };
}

describe("plugin doctor", () => {
	it("reads stock omp plugin doctor --json rows and drops rows of another shape", async () => {
		const stdout = JSON.stringify([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools", fixed: false },
			{ name: "orphan:bar", status: "error" },
			{ name: "odd", status: "unknown", message: "?" },
			"noise",
		]);
		const { call } = await fixture(`
if (JSON.stringify(process.argv.slice(2)) !== '["plugin","doctor","--json"]'
  || process.env.NO_COLOR !== "1" || process.env.FORCE_COLOR !== "0"
  || process.env.OTEL_SDK_DISABLED !== "true" || (await Bun.stdin.text()) !== ""
  || !(await Bun.file("fake omp/body.ts").exists())) throw new Error("wrong launch");
process.stdout.write(${JSON.stringify(stdout)});`);
		await expect(call("get_plugin_doctor")).resolves.toEqual({
			checks: [
				{ name: "plugins_directory", status: "warning", message: "Not created yet" },
				{ name: "plugin:foo", status: "ok", message: "v1.2.0 - Foo tools" },
				{ name: "orphan:bar", status: "error", message: "" },
			],
			checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
		});
	});

	it.each(["Plugin doctor\n✓ ok", '{"checks":[]}'])("rejects non-array output %s", async stdout => {
		const { call } = await fixture(`process.stdout.write(${JSON.stringify(stdout)});`);
		await expect(call("get_plugin_doctor")).rejects.toMatchObject({
			name: "LocalCommandError",
			code: "doctor_failed",
			message: stdout,
		});
	});

	it.each([
		["drop\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n", "1\n2\n3\n4\n5\n6"],
		[" ", "omp plugin doctor exited with code 7"],
	])("reports stock's nonzero exit even with valid stdout", async (stderr, message) => {
		const { call } = await fixture(
			`console.log("[]"); process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 7;`,
		);
		await expect(call("get_plugin_doctor")).rejects.toMatchObject({
			name: "LocalCommandError",
			code: "doctor_failed",
			message,
		});
	});
});

it.each([
	["Already up to date", "18.6.1", false],
	["New version available: 18.7.0-canary.3", "18.7.0-canary.3", true],
])("checks this install without changing it: %s", async (stock, latestVersion, updateAvailable) => {
	const { cwd, call } = await fixture(`
import { realpathSync } from "node:fs";
import { delimiter, dirname } from "node:path";
if (JSON.stringify(process.argv.slice(2)) !== '["update","--check"]'
  || process.env.NO_COLOR !== "1" || process.env.FORCE_COLOR !== "0"
  || process.env.OTEL_SDK_DISABLED !== "true" || (await Bun.stdin.text()) !== ""
  || realpathSync.native(process.env.PATH.split(delimiter)[0]) !== realpathSync.native(dirname(import.meta.path))
  || realpathSync.native(process.env.BUN_INSTALL) !== realpathSync.native(process.cwd())) throw new Error("wrong launch");
console.log(${JSON.stringify(`Current version: 18.6.1\r\n${stock}`)});`);
	const pkg = join(cwd, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), "{}");
	await expect(call("get_omp_update")).resolves.toEqual({
		currentVersion: "18.6.1",
		latestVersion,
		updateAvailable,
		distribution: "system",
		installStrategy: "omp-update",
		checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/),
	});
});

it.each([
	["Current version: 18.6.1", "", 0, "Current version: 18.6.1"],
	["Current version: 18.6.1\nAlready up to date", "discard\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6", 1, "1\n2\n3\n4\n5\n6"],
	["", "", 2, "omp update --check exited with code 2"],
])("rejects a failed update check with stock's detail", async (stdout, stderr, code, message) => {
	const { call } = await fixture(`
process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${code};`);
	await expect(call("get_omp_update")).rejects.toMatchObject({
		name: "LocalCommandError",
		code: "update_check_failed",
		message,
	});
});

describe("omp updates", () => {
	it("has no local handler that runs `omp update` itself: a host updates through its OmpUpdater (host.ompUpdate.now)", () => {
		// A bare `omp update` here skipped the stats and helper release, the setup supervisor, the omp re-detection,
		// the tab restart and the serialization against the host's own scheduled update.
		expect(Object.hasOwn(handlers, "omp_update")).toBe(false);
	});
});
