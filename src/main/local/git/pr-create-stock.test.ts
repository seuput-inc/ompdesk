/**
 * prCreate (pr.ts, run by the core process: crates/core/src/gh/pr.rs) against its stock counterpart,
 * tools/gh-pr-checkout.ts#executePrCreate: for the same input, both hand a recording `gh` the same flags with the same
 * body text, and read the same PR number from gh's output (stock's follow-up `gh pr view <n>` names it).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writeFakeBin } from "../../test-fake-omp";
import { prCreate } from "./pr";
import { initRepo } from "./test-repos";

const stockModules = path.join(os.homedir(), ".bun/install/global/node_modules");
const stockRoot = path.join(stockModules, "@oh-my-pi/pi-coding-agent");
const GH_OUTPUT = "Creating pull request for feat into main in o/r\n\nhttps://github.com/o/r/pull/7\n";

/** `--flag value` pairs and bare flags, order-free; the body file is compared by content. */
function flagSet(args: string[]): string[] {
	const flags: string[] = [];
	for (let index = 2; index < args.length; index++) {
		const flag = args[index] ?? "";
		const value = args[index + 1];
		if (value === undefined || value.startsWith("--")) flags.push(flag);
		else {
			flags.push(`${flag}=${flag === "--body-file" ? "<file>" : value}`);
			index++;
		}
	}
	return flags.sort();
}

/** A gh that records `pr create`'s arguments and body file into `dir`, answers `repo view`, and records `pr view`'s number. */
function recordingGh(dir: string): string {
	const file = (name: string) => JSON.stringify(path.join(dir, name));
	return `import { copyFileSync, writeFileSync } from "node:fs";
const [verb, noun, ...rest] = process.argv.slice(2);
if (verb === "pr" && noun === "create") {
	const args = process.argv.slice(2);
	writeFileSync(${file("create.args")}, args.map(arg => arg + "\\n").join(""));
	const body = args.indexOf("--body-file");
	if (body >= 0) copyFileSync(args[body + 1], ${file("body.md")});
	process.stdout.write(${JSON.stringify(GH_OUTPUT)});
	process.exit(0);
}
if (verb === "repo" && noun === "view") {
	process.stdout.write('{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}');
	process.exit(0);
}
if (verb === "pr" && noun === "view") writeFileSync(${file("view.args")}, rest[0] + "\\n");
process.exit(1);
`;
}

// Stock uses Bun/native modules, which cannot execute in Vitest's Node worker, so it runs in a bun child.
describe.skipIf(!fs.existsSync(stockRoot))("prCreate against stock executePrCreate", () => {
	it("passes stock's gh pr create flags and reads stock's PR number", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-stock-pr-"));
		const savedPath = process.env.PATH;
		try {
			const bin = path.join(dir, "bin");
			fs.mkdirSync(bin);
			fs.symlinkSync(stockModules, path.join(dir, "node_modules"), "junction");
			// A gh.exe on Windows (`resolveBin` starts no other there), so neither side finds the machine's real gh.
			await writeFakeBin(bin, "gh", recordingGh(dir));
			// The recording gh answers before any gh the machine has: stock's spawn and `resolveBin` read PATH first.
			process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
			process.env.OMP_GUI_TEST_BREW_DIRS = "";
			const input = {
				title: "Add feature",
				body: "Line one\n\nLine two",
				base: "main",
				head: "feat",
				draft: true,
			};
			fs.writeFileSync(
				path.join(dir, "check.ts"),
				`import { executePrCreate } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-checkout";
await executePrCreate({ cwd: process.argv[2] }, ${JSON.stringify({ repo: "o/r", ...input })}, undefined);
console.log("stock pr create done");
`,
			);
			expect(
				execFileSync("bun", [path.join(dir, "check.ts"), dir], { encoding: "utf8", timeout: 30_000 }),
			).toContain("stock pr create done");
			const stockArgs = fs.readFileSync(path.join(dir, "create.args"), "utf8").trimEnd().split("\n");
			const stockBody = fs.readFileSync(path.join(dir, "body.md"), "utf8");
			const stockNumber = Number(fs.readFileSync(path.join(dir, "view.args"), "utf8").trim());
			fs.rmSync(path.join(dir, "create.args"));
			fs.rmSync(path.join(dir, "body.md"));

			const repo = path.join(dir, "repo");
			await initRepo(repo);
			const created = await prCreate(repo, input);
			const ourArgs = fs.readFileSync(path.join(dir, "create.args"), "utf8").trimEnd().split("\n");

			expect(stockArgs.slice(0, 2)).toEqual(["pr", "create"]);
			expect(ourArgs.slice(0, 2)).toEqual(["pr", "create"]);
			expect(flagSet(ourArgs)).toEqual(flagSet(stockArgs));
			expect(stockBody).toBe(input.body);
			expect(fs.readFileSync(path.join(dir, "body.md"), "utf8")).toBe(stockBody);
			expect(created).toEqual({ url: "https://github.com/o/r/pull/7", number: stockNumber });
		} finally {
			process.env.PATH = savedPath;
			delete process.env.OMP_GUI_TEST_BREW_DIRS;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);
});
