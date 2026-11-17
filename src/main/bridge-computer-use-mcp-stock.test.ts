/**
 * The agent-desktop root (`resources/omp-builtin/agent-desktop/.mcp.json`) against the installed omp's real MCP
 * manager, mounted with `-e` and its command from `OMP_GUI_AGENT_DESKTOP` as in a session OMPdesk spawns:
 * - the startup check (resources/gui-bridge/modes/computer-use-core.ts `checkServer`), read once the omp has started its
 *   MCP servers. A stand-in stdio server plays agent-desktop (the real one is not needed to pin what stock reports):
 *   one that answers, one that does not exist, one that exits at once, one that never answers. On Windows the
 *   stand-in is a compiled exe, as agent-desktop is (`writeFakeBin`).
 * - the request deadline stock gives agent-desktop's calls, which needs no server.
 * Skipped without an installed omp.
 */
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_DESKTOP_ENV } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";
import { RM_TEMP, writeFakeBin } from "./test-fake-omp";

/** A command no machine has: stock's spawn fails at once. */
const MISSING = join(tmpdir(), "ompdesk-no-such-agent-desktop");

/** Answers `initialize` and `tools/list` like a server that works; `FAKE_MODE` makes it exit or stay silent. */
const FAKE_SERVER = `
if (process.env.FAKE_MODE === "exit") process.exit(3);
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let buffer = "";
process.stdin.on("data", chunk => {
	buffer += chunk;
	for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
		const line = buffer.slice(0, end).trim();
		buffer = buffer.slice(end + 1);
		if (!line || process.env.FAKE_MODE === "silent") continue;
		const message = JSON.parse(line);
		if (message.id === undefined) continue;
		if (message.method === "initialize") {
			send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-agent-desktop", version: "0" } } });
		} else if (message.method === "tools/list") {
			send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "desktop_status", description: "status", inputSchema: { type: "object", properties: {} } }] } });
		} else send({ jsonrpc: "2.0", id: message.id, result: {} });
	}
});
`;

const PROBE = `
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { checkServer } from "./modes/computer-use-core";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const started = Date.now();
   const verdict = await checkServer(() => MCPManager.instance(), Number(process.env.CHECK_MS));
   console.error("CHECK_PROBE=" + JSON.stringify({ verdict, ms: Date.now() - started }));
  } catch (err) {
   console.error("CHECK_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

/** The server config stock's manager holds for `agent-desktop`: what its transport takes each request's deadline from. */
const CONFIG_PROBE = `
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
export default function (pi) {
 pi.on("session_start", async () => {
  const config = MCPManager.instance()?.getServerConfig("agent-desktop");
  console.error("CHECK_PROBE=" + JSON.stringify({ found: config !== undefined, timeout: config?.timeout ?? null }));
  process.exit(0);
 });
}
`;

interface Probe {
	verdict: { ok: true } | { ok: false; error: string };
	ms: number;
}

/**
 * Async, not `spawnSync`: a Windows omp takes up to 30 s to start, and a worker blocked across the cases misses
 * vitest's RPC deadline ("Timeout calling onTaskUpdate", flake-probe run 44133247071).
 */
async function runCheck<T = Probe>(command: string, mode: string, checkMs: number, probe = PROBE): Promise<T> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-computer-use-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "check-probe.ts");
		writeFileSync(extension, probe);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			FAKE_MODE: mode,
			CHECK_MS: String(checkMs),
			[AGENT_DESKTOP_ENV]: command,
		};
		// An `OMP_MCP_TIMEOUT_MS` of the shell would override every server's own deadline.
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"OMP_MCP_TIMEOUT_MS",
		]) {
			Reflect.deleteProperty(env, key);
		}
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc",
				"--no-session",
				"--no-skills",
				"--no-rules",
				"-e",
				resolve("resources/omp-builtin/agent-desktop"),
				"-e",
				extension,
			],
			{ env, stdio: ["pipe", "ignore", "pipe"] },
		);
		child.stdin.end();
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += String(chunk);
		});
		const closed = Promise.withResolvers<void>();
		child.once("close", () => closed.resolve());
		child.once("error", error => closed.reject(error));
		const timer = setTimeout(() => child.kill(), 120_000);
		await closed.promise.finally(() => clearTimeout(timer));
		const line = stderr.split(/\r?\n/).find(value => value.startsWith("CHECK_PROBE="));
		expect(line, stderr.slice(-2500)).toMatch(/^CHECK_PROBE=/);
		return JSON.parse(line?.slice("CHECK_PROBE=".length) ?? "{}") as T;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("the agent-desktop check on stock's MCP manager", () => {
	let dir = "";
	let server = "";
	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-fake-agent-desktop-"));
		server = await writeFakeBin(dir, "fake-agent-desktop", FAKE_SERVER);
	}, 120_000);
	afterAll(() => rmSync(dir, RM_TEMP));

	it("passes a server that answers", async () => {
		const { verdict } = await runCheck(server, "", 15_000);
		expect(verdict).toEqual({ ok: true });
	}, 130_000);

	it("fails a command that does not exist, with stock's own error and without waiting out the bound", async () => {
		const { verdict, ms } = await runCheck(MISSING, "", 15_000);
		expect(verdict.ok).toBe(false);
		expect(ms).toBeLessThan(15_000);
	}, 130_000);

	it("fails a server that exits at once", async () => {
		const { verdict, ms } = await runCheck(server, "exit", 15_000);
		expect(verdict.ok).toBe(false);
		expect(ms).toBeLessThan(15_000);
	}, 130_000);

	it("fails a server that never answers at the bound, as not started in time", async () => {
		const { verdict, ms } = await runCheck(server, "silent", 3_000);
		expect(verdict).toEqual({ ok: false, error: "did not start in time" });
		expect(ms).toBeGreaterThanOrEqual(3_000);
	}, 130_000);
});

describe.skipIf(!existsSync(omp))("agent-desktop's request deadline on stock's MCP manager", () => {
	it("outlasts agent-desktop's own 30 s waits, which a Windows launch of Notepad runs out before it answers", async () => {
		const probe = await runCheck<{ found: boolean; timeout: number | null }>(MISSING, "", 0, CONFIG_PROBE);
		expect(probe.found).toBe(true);
		// Without its own value stock cuts every request off at 30 s, the moment agent-desktop's launch, `wait` and
		// `--wait-for` give up and answer.
		expect(probe.timeout).toBeGreaterThanOrEqual(60_000);
	}, 130_000);
});
