import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { INSTALLED_OMP, OMP_COMMAND, stopOmpDaemon } from "../test-bridge-probe";

const exec = promisify(execFile);
const provider = resolve("resources/gui-bridge/ponytail.ts");
const skills = resolve("resources/omp-builtin/ponytail/skills");
const names = ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"];
const observer = `export default pi => pi.on("session_start", async () => {
 try {
  const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
  const runner = session.extensionRunner;
  const prompt = async () => (await runner.emitBeforeAgentStart("Fix the bug", undefined, ["base"]))?.systemPrompt?.join("\\n") ?? "base";
  const skills = pi.getCommands().filter(c => c.name.startsWith("skill:") && c.name.includes("ponytail"));
  const found = skills.map(c => [c.name, c.path]).sort();
  const initial = await prompt();
  const command = runner.getCommand("ponytail");
  const level = process.env.PONYTAIL_PROBE_SET;
  if (level) {
   if (!command) throw new Error("Missing /ponytail command");
   await command.handler(level, runner.createCommandContext());
   await session.sessionManager.ensureOnDisk();
   await session.sessionManager.flush();
  }
  console.error("PONYTAIL=" + JSON.stringify({found, command: !!command, initial, changed: level ? await prompt() : null, file: session.sessionManager.getSessionFile()}));
  process.exit(0);
 } catch (err) {
  console.error(err);
  process.exit(1);
 }
});`;

interface Observation {
	found: [string, string][];
	command: boolean;
	initial: string;
	changed: string | null;
	file: string;
}

it.skipIf(!existsSync(INSTALLED_OMP)).each([
	["user", "off"],
	["project", "lite"],
])(
	"respects %s marketplace installs and restores /ponytail %s after restart",
	async (scope, level) => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "ponytail-stock-")));
		const project = join(home, "project");
		const nested = join(project, "nested");
		const market = join(home, "market");
		const probe = join(home, "commands.ts");
		const env = {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			HOME: home,
			USERPROFILE: home,
			PI_CONFIG_DIR: ".omp",
			XDG_CONFIG_HOME: join(home, ".config"),
			APPDATA: join(home, "appdata"),
			LOCALAPPDATA: join(home, "localappdata"),
			TMPDIR: home,
			TEMP: home,
			TMP: home,
			OPENAI_API_KEY: "offline-fixture",
			OTEL_SDK_DISABLED: "true",
		};
		const omp = (cwd: string, ...args: string[]) =>
			exec(OMP_COMMAND.file, [...OMP_COMMAND.args, ...args], { cwd, env, timeout: 90_000 });
		const discover = async (options: { terminal?: boolean; set?: string; resume?: string } = {}) => {
			const args = [
				"--offline",
				"--mode",
				"rpc-ui",
				...(options.resume ? ["--session", options.resume] : options.set ? [] : ["--no-session"]),
				...(options.terminal ? [] : ["-e", provider]),
				"-e",
				probe,
			];
			const { stderr } = await exec(OMP_COMMAND.file, [...OMP_COMMAND.args, ...args], {
				cwd: nested,
				env: {
					...env,
					...(options.terminal ? {} : { PONYTAIL_DEFAULT_MODE: "full" }),
					PONYTAIL_PROBE_SET: options.set,
				},
				timeout: 90_000,
			});
			const report = stderr.split(/\r?\n/).find(line => line.startsWith("PONYTAIL="));
			if (!report) throw new Error(`Missing discovery result: ${stderr}`);
			return {
				...(JSON.parse(report.slice(9)) as Observation),
				hooks: stderr.split("PONY_HOOK_BOUND").length - 1,
			};
		};
		try {
			mkdirSync(join(project, ".omp"), { recursive: true });
			mkdirSync(nested);
			writeFileSync(probe, observer);
			const fresh = await discover({ set: level });
			expect(fresh.found).toEqual(names.map(name => [`skill:${name}`, join(skills, name, "SKILL.md")]));
			expect(fresh.hooks).toBe(0);
			expect(fresh.initial).toContain("PONYTAIL MODE ACTIVE — level: full");
			expect(fresh.initial).toContain("## Before you write");
			const resumed = await discover({ resume: fresh.file });
			for (const prompt of [fresh.changed, resumed.initial]) {
				if (level === "off") {
					expect(prompt).not.toContain("PONYTAIL MODE ACTIVE");
					expect(prompt).not.toContain("## Before you write");
				} else {
					expect(prompt).toContain("PONYTAIL MODE ACTIVE — level: lite");
					expect(prompt).not.toContain("PONYTAIL MODE ACTIVE — level: full");
				}
			}
			const control = await discover({ terminal: true });
			expect(control).toMatchObject({ found: [], command: false });
			expect(control.initial).not.toContain("PONYTAIL MODE ACTIVE");
			expect(existsSync(join(env.XDG_CONFIG_HOME, "ponytail", "config.json"))).toBe(false);

			// Local catalog with the official id and Pi manifest shape, but different bodies and a harmless hook counter.
			mkdirSync(join(market, ".claude-plugin"), { recursive: true });
			writeFileSync(
				join(market, ".claude-plugin", "marketplace.json"),
				JSON.stringify({
					name: "ponytail",
					owner: { name: "fixture" },
					plugins: [{ name: "ponytail", source: "./" }],
				}),
			);
			writeFileSync(
				join(market, ".claude-plugin", "plugin.json"),
				JSON.stringify({ name: "ponytail", version: "1.0.0" }),
			);
			writeFileSync(
				join(market, "package.json"),
				JSON.stringify({
					name: "@dietrichgebert/ponytail",
					version: "1.0.0",
					pi: { extensions: ["./hook.js"], skills: ["./skills"] },
				}),
			);
			writeFileSync(join(market, "hook.js"), 'export default () => console.error("PONY_HOOK_BOUND");');
			for (const name of names) {
				const dir = join(market, "skills", name);
				mkdirSync(dir, { recursive: true });
				writeFileSync(
					join(dir, "SKILL.md"),
					`---\nname: ${name}\ndescription: fixture\n---\nPersonal plugin version\n`,
				);
			}
			await omp(project, "plugin", "marketplace", "add", market);
			await omp(project, "plugin", "install", "ponytail@ponytail", "--scope", scope);
			const enabled = await discover();
			expect(enabled.found.map(([name]) => name)).toEqual(names.map(name => `skill:${name}`));
			expect(enabled.found.every(([, file]) => realpathSync(file).startsWith(home))).toBe(true);
			expect(enabled.hooks).toBe(1);
			expect(enabled.command).toBe(false);
			expect(enabled.initial).not.toContain("PONYTAIL MODE ACTIVE");
			await omp(project, "plugin", "disable", "ponytail@ponytail", "--scope", scope);
			const disabled = await discover();
			expect(disabled).toMatchObject({ found: [], hooks: 0, command: false });
			expect(disabled.initial).not.toContain("PONYTAIL MODE ACTIVE");
		} finally {
			stopOmpDaemon(join(home, ".omp"), env);
			rmSync(home, { recursive: true, force: true, maxRetries: 5 });
		}
	},
	180_000,
);
