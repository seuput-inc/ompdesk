import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { SessionArchive } from "../shared/diagnostic-bundle";
import { core } from "./core/process";
import { OMP_COMMAND, INSTALLED_OMP as omp, stockFixtureEnv, stopOmpDaemon } from "./test-bridge-probe";

/** Exercises the installed stock dump methods and the bridge that redacts their ZIP before it answers. */

const SEED = `
const outputs = JSON.parse(process.env.OMP_GUI_TEST_DUMP_OUTPUTS);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = content => ({ role: "user", content, timestamp: Date.now() });
const reply = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt-probe", usage, stopReason: "stop", timestamp: Date.now() });
async function seed(session, text = "dump probe question") {
 const sm = session.sessionManager;
 const question = user([{ type: "text", text }]);
 const answer = reply("dump probe answer");
 sm.appendMessage(question);
 sm.appendMessage(answer);
 await sm.flush();
 session.agent.replaceMessages([question, answer]);
}
`;

const BRIDGE_PROBE = `
import { methods } from "./session-dump";
${SEED}
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const empty = await methods.session_dump_redacted({ output: outputs[0] }, env);
   await seed(session);
   const all = await methods.session_dump_redacted({ output: outputs[0] }, env);
   const anon = await methods.session_dump_redacted({ output: outputs[1], anonymized: true }, env);
   console.error("DUMP_PROBE=" + JSON.stringify({ empty, all, anon }));
  } catch (err) {
   console.error("DUMP_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

const RPC_PROBE = `
${SEED}
export default function (pi) {
 pi.on("session_start", async () => {
  await seed(pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session);
 });
}
`;

/** Fake secrets of every kind the redactor knows; none needs escaping inside JSON. */
const SECRETS = [
	`ghp_${"a1B2".repeat(9)}`,
	"sk-proj-0123456789abcdefABCDEF",
	"8f14e45fceea167a",
	"jane.doe@example.com",
	"100.101.102.103",
	"192.168.1.23",
	"/Users/janedoe",
];
const SECRET_LINE = `deploy with ${SECRETS[0]} and ${SECRETS[1]}, header Bearer ${SECRETS[2]}, mail ${SECRETS[3]}, host ${SECRETS[4]} or ${SECRETS[5]}, files in ${SECRETS[6]}/proj`;

/** The main transcript and one subagent transcript (stored next to the session file, as stock keeps them) carry every secret. */
const PRIVACY_PROBE = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeArchive, readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { methods } from "./session-dump";
${SEED}
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   await seed(session, ${JSON.stringify(`MAIN ${SECRET_LINE}`)});
   const file = session.sessionManager.getSessionFile();
   const dir = file.slice(0, -6);
   mkdirSync(dir, { recursive: true });
   writeFileSync(dir + "/Probe.jsonl", readFileSync(file, "utf8").replaceAll("MAIN ", "SUBAGENT "));
   const originals = [];
   let rawHadSecrets = false;
   env.session = () => ({
    dumpSessionArchiveToTmpDir: async () => {
     const raw = await session.dumpSessionArchiveToTmpDir();
     originals.push(raw.path);
     const entries = await readArchiveEntries(raw.path);
     rawHadSecrets = ["session.md", "llm-request.json", "subagents/Probe.md"].every(
      name => new TextDecoder().decode(entries.get(name)).includes(${JSON.stringify(SECRETS[3])}));
     return raw;
    },
    dumpAnonymizedArchiveToTmpDir: async () => {
     const raw = await session.dumpAnonymizedArchiveToTmpDir();
     originals.push(raw.path);
     return raw;
    },
   });
   const all = await methods.session_dump_redacted({ output: outputs[0] }, env);
   const anon = await methods.session_dump_redacted({ output: outputs[1], anonymized: true }, env);
   const fixture = join(tmpdir(), "synthetic-stock.zip");
   const fixtureArchive = { path: fixture, files: [], subagentCount: 0 };
   env.session = () => ({
    dumpSessionArchiveToTmpDir: async () => fixtureArchive,
    dumpAnonymizedArchiveToTmpDir: async () => fixtureArchive,
   });
   writeFileSync(fixture, await encodeArchive("zip", [["invalid.bin", new Uint8Array([255])], ["nul.txt", "a\\0b"]]));
   const dropped = await methods.session_dump_redacted({ output: outputs[2] }, env);
   writeFileSync(fixture, "not a zip");
   const corruptFailed = await methods.session_dump_redacted({ output: outputs[2] }, env).then(() => false, () => true);
   writeFileSync(fixture, await encodeArchive("zip", [["session.md", "sample"]]));
   const previous = readFileSync(outputs[2]);
   const reusedFailed = await methods.session_dump_redacted({ output: outputs[2] }, env).then(() => false, () => true);
   console.error("DUMP_PROBE=" + JSON.stringify({ all, anon, dropped, rawHadSecrets, corruptFailed,
    reservationRefused: reusedFailed && readFileSync(outputs[2]).equals(previous),
    originalsGone: [...originals, fixture].every(path => !existsSync(path)) }));
  } catch (err) {
   console.error("DUMP_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

async function texts(file: string): Promise<Record<string, string>> {
	const zip = await JSZip.loadAsync(await readFile(file));
	const out: Record<string, string> = {};
	for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) out[name] = await entry.async("string");
	return out;
}

async function isolatedRun(
	probe: string,
	file: string,
	input: string,
	destinations: number,
	body: (dirs: { temp: string }, result: { stdout: string; stderr: string }) => Promise<void>,
): Promise<void> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-dump-"));
	chmodSync(isolated, 0o700);
	const temp = join(isolated, "tmp");
	mkdirSync(temp);
	cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
	const extension = join(isolated, "bridge", file);
	writeFileSync(extension, probe);
	const env = {
		...stockFixtureEnv(isolated),
		TMP: temp,
		TEMP: temp,
		TMPDIR: temp,
		OPENAI_API_KEY: "probe-not-a-real-key",
		OMP_GUI_TEST_DUMP_OUTPUTS: "[]",
	};
	const grants: Array<{ path: string; receipt: string }> = [];
	try {
		for (let i = 0; i < destinations; i++)
			grants.push((await core().call<{ path: string; receipt: string }>("archive.prepare", {})).result);
		env.OMP_GUI_TEST_DUMP_OUTPUTS = JSON.stringify(grants.map(grant => grant.path));
		const result = spawnSync(
			OMP_COMMAND.file,
			[...OMP_COMMAND.args, "--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{
				cwd: isolated,
				env,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
				input,
			},
		);
		await body({ temp }, result);
	} finally {
		try {
			await Promise.all(grants.map(grant => core().call("archive.discard", grant)));
		} finally {
			stopOmpDaemon(isolated, env);
			rmSync(isolated, { recursive: true, force: true });
		}
	}
}

const members = async (file: string) => Object.keys((await JSZip.loadAsync(await readFile(file))).files).sort();

describe.skipIf(!existsSync(omp))("session dump on stock omp", () => {
	it("hands back stock's `/dump all` and `/dump anon` zips: session.md for all, session.jsonl for anon, null while empty", async () => {
		await isolatedRun(BRIDGE_PROBE, "dump-probe.ts", "", 2, async (_dirs, { stderr }) => {
			const line = stderr.split("\n").find(value => value.startsWith("DUMP_PROBE="));
			expect(line, stderr.slice(-2500)).toMatch(/^DUMP_PROBE=/);
			const out = JSON.parse(line?.slice("DUMP_PROBE=".length) ?? "{}") as {
				empty: null;
				all: SessionArchive;
				anon: SessionArchive;
			};
			expect(out.empty).toBeNull();
			expect(out.all.anonymized).toBe(false);
			expect(out.all.files).toEqual(expect.arrayContaining(["session.md"]));
			expect(await members(out.all.path)).toEqual(expect.arrayContaining(["session.md"]));
			expect(out.anon.anonymized).toBe(true);
			expect(out.anon.files).toEqual(["session.jsonl"]);
			expect(await members(out.anon.path)).toEqual(["session.jsonl"]);
			const transcript = await (await JSZip.loadAsync(await readFile(out.all.path))).files["session.md"]?.async(
				"string",
			);
			expect(transcript).toContain("dump probe question");
		});
	}, 130_000);

	it("answers `/dump all` over RPC with a command_output text frame only: no structured archive to copy", async () => {
		const input = `${JSON.stringify({ id: "d1", type: "prompt", message: "/dump all" })}\n`;
		await isolatedRun(RPC_PROBE, "rpc-probe.ts", input, 0, async ({ temp }, { stdout }) => {
			const frames = stdout
				.split("\n")
				.filter(value => value.startsWith("{"))
				.map(value => JSON.parse(value) as Record<string, unknown>);
			const output = frames.find(frame => frame.type === "command_output");
			expect(output, stdout.slice(-2500)).toBeDefined();
			expect(String(output?.text)).toMatch(/Session dump archive: .*omp-dump-.*\.zip/);
			// Nothing in the frame is data: the path is prose, and no frame carries the archive as a field.
			expect(Object.keys(output ?? {}).sort()).toEqual(["text", "type"]);
			expect(frames.some(frame => "path" in frame && String(frame.path).endsWith(".zip"))).toBe(false);
			expect(temp).toBeTruthy();
		});
	}, 130_000);

	it("hides every secret in every member of both bundles, and leaves no stock archive behind", async () => {
		await isolatedRun(PRIVACY_PROBE, "privacy-probe.ts", "", 3, async (_dirs, { stderr }) => {
			const line = stderr.split("\n").find(value => value.startsWith("DUMP_PROBE="));
			expect(line, stderr.slice(-2500)).toMatch(/^DUMP_PROBE=/);
			const out = JSON.parse(line?.slice("DUMP_PROBE=".length) ?? "{}") as {
				all: SessionArchive;
				anon: SessionArchive;
				dropped: SessionArchive;
				corruptFailed: boolean;
				reservationRefused: boolean;
				rawHadSecrets: boolean;
				originalsGone: boolean;
			};
			expect(out.rawHadSecrets).toBe(true);
			expect(out.originalsGone).toBe(true);
			expect(out.corruptFailed).toBe(true);
			expect(out.reservationRefused).toBe(true);
			expect(out.dropped.dropped).toEqual(["invalid.bin", "nul.txt"]);
			expect(await members(out.dropped.path)).toEqual([]);
			for (const bundle of [out.all, out.anon]) {
				expect(bundle.redacted).toBe(true);
				const members = await texts(bundle.path);
				expect(Object.keys(members).sort()).toEqual([...bundle.files].sort());
				for (const [name, text] of Object.entries(members)) {
					for (const secret of [...SECRETS, homedir()])
						expect(text, `${name} holds ${secret}`).not.toContain(secret);
					if (name.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
					if (name.endsWith(".jsonl"))
						for (const row of text.split("\n").filter(Boolean)) expect(() => JSON.parse(row)).not.toThrow();
				}
			}
		});
	}, 130_000);
});
