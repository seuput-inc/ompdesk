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
const observer = `export default pi => pi.on("session_start", () => {
 const skills = pi.getCommands().filter(c => c.name.startsWith("skill:") && c.name.includes("ponytail"));
 console.error("PONYTAIL=" + JSON.stringify(skills.map(c => [c.name, c.path]).sort()));
 process.exit(0);
});`;

it.skipIf(!existsSync(INSTALLED_OMP)).each(["user", "project"])(
	"uses the bundle only without a %s marketplace install, including from a nested folder",
	async scope => {
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
		const discover = async () => {
			const { stderr } = await omp(
				nested,
				"--offline",
				"--mode",
				"rpc-ui",
				"--no-session",
				"-e",
				provider,
				"-e",
				probe,
			);
			const report = stderr.split(/\r?\n/).find(line => line.startsWith("PONYTAIL="));
			if (!report) throw new Error(`Missing discovery result: ${stderr}`);
			return {
				found: JSON.parse(report.slice(9)) as [string, string][],
				hooks: stderr.split("PONY_HOOK_BOUND").length - 1,
			};
		};
		try {
			mkdirSync(join(project, ".omp"), { recursive: true });
			mkdirSync(nested);
			writeFileSync(probe, observer);
			expect(await discover()).toEqual({
				found: names.map(name => [`skill:${name}`, join(skills, name, "SKILL.md")]),
				hooks: 0,
			});

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
			await omp(project, "plugin", "disable", "ponytail@ponytail", "--scope", scope);
			expect(await discover()).toEqual({ found: [], hooks: 0 });
		} finally {
			stopOmpDaemon(join(home, ".omp"), env);
			rmSync(home, { recursive: true, force: true, maxRetries: 5 });
		}
	},
	180_000,
);
