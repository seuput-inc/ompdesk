// PROBE ONLY (branch probe/mw-mac, never main): builds, then runs one e2e spec `--repeat` times with retries off.
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const spec = args[0];
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const repeat = flag("--repeat") ?? "10";
const grep = flag("--grep");
const run = (cmd: string[]) => spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false }).status ?? 1;
if (run(["bun", "run", "build"]) !== 0) process.exit(1);
process.exit(
	run([
		"bunx",
		"playwright",
		"test",
		spec,
		"--repeat-each",
		repeat,
		"--retries",
		"0",
		"--trace",
		"retain-on-failure",
		"--reporter",
		"list",
		...(grep ? ["--grep", grep] : []),
	]),
);
