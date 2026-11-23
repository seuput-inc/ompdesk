import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { StockHelper } from "./stock-helper";
import { searchPattern, searchWorkspace } from "./workspace-search";

const base = { query: "a.b", matchCase: false, wholeWord: false, regex: false, glob: "" };
const stockHost = resolve("resources/gui-bridge/stock-helper/host.ts");
const realOmp = join(homedir(), ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const failed = { ok: false, matches: [], files: 0, limited: false };

function stock(omp: string): StockHelper {
	return new StockHelper("", {
		launch: async () => ({
			bin: "bun",
			args: [stockHost, "stock"],
			env: { ...process.env, OMP_PACKAGE_ROOT: omp },
		}),
	});
}

describe("Files content search", () => {
	it("escapes plain text, keeps a regex and wraps whole words", () => {
		expect(searchPattern(base)).toBe("a\\.b");
		expect(searchPattern({ ...base, regex: true })).toBe("a.b");
		expect(searchPattern({ ...base, wholeWord: true })).toBe("\\b(?:a\\.b)\\b");
	});
	it("hands stock grep the pattern, case, glob and caps through the real core in request order", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-search-"));
		const natives = join(dir, "node_modules", "@oh-my-pi", "pi-natives");
		const log = join(dir, "options.jsonl");
		const helper = stock(dir);
		const ask = helper.request.bind(helper);
		const search = (options: Partial<typeof base>) => searchWorkspace("/repo", { ...base, ...options }, ask);
		try {
			await mkdir(natives, { recursive: true });
			await writeFile(join(dir, "package.json"), "{}");
			await writeFile(join(natives, "package.json"), JSON.stringify({ exports: "./index.mjs" }));
			await writeFile(
				join(natives, "index.mjs"),
				`import { appendFileSync } from "node:fs";
export function grep(options) {
	appendFileSync(${JSON.stringify(log)}, JSON.stringify(options) + "\\n");
	if (options.pattern === "(?<=a)b") throw new Error("grep rejected the pattern");
	return { matches: [{ path: "src\\\\a.ts", lineNumber: 3, line: "a.b", column: 2 }], filesWithMatches: 1, limitReached: true };
}`,
			);
			const [plain, regex, rejected] = await Promise.all([
				search({ matchCase: true, glob: "\uFEFF*.ts\u2029" }),
				search({ regex: true, wholeWord: true, query: "(?<part>a)\\k<part>\ud800" }),
				search({ regex: true, query: "(?<=a)b" }),
			]);
			const match = {
				ok: true,
				matches: [{ path: "src/a.ts", line: 3, text: "a.b", column: 2 }],
				files: 1,
				limited: true,
			};
			expect(plain).toEqual(match);
			expect(regex).toEqual(match);
			expect(rejected).toEqual({ ...failed, error: "grep rejected the pattern" });
			const options = {
				path: "/repo",
				hidden: false,
				gitignore: true,
				maxCount: 500,
				maxColumns: 240,
				maxCountPerFile: 50,
				timeoutMs: 15_000,
			};
			const lines = (await readFile(log, "utf8")).trimEnd().split("\n");
			expect(lines.map(line => JSON.parse(line))).toEqual([
				{ ...options, pattern: "a\\.b", ignoreCase: false, glob: "*.ts" },
				{ ...options, pattern: "\\b(?:(?<part>a)\\k<part>\ud800)\\b", ignoreCase: true },
				{ ...options, pattern: "(?<=a)b", ignoreCase: true },
			]);
		} finally {
			await helper.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses missing roots, invalid requests and V8-invalid patterns before it asks for a worker", async () => {
		let calls = 0;
		const helper = async () => {
			calls++;
			return { matches: [], files: 0, limited: false };
		};
		const bad = { ...base, regex: true, wholeWord: true, query: "(" };
		expect(await searchWorkspace(null, bad, helper)).toEqual({
			...failed,
			error: "No workspace",
			code: "no_workspace",
		});
		const invalid = [
			{ ...bad, query: "" },
			{ ...bad, glob: "😀".repeat(201) },
			{ ...base, query: "😀".repeat(1001) },
			{ ...base, matchCase: 1 },
		];
		for (const request of invalid) {
			expect(await searchWorkspace("/repo", request, helper)).toEqual({
				...failed,
				error: "Invalid search",
				code: "invalid_path",
			});
		}
		expect(await searchWorkspace("/repo", bad, helper)).toEqual({
			...failed,
			error: "Invalid regular expression: /\\b(?:()\\b/: Unterminated group",
			code: "invalid_regex",
		});
		expect(calls).toBe(0);
		const limit = { ...base, query: "😀".repeat(1000), glob: "😀".repeat(200) };
		expect((await searchWorkspace("/repo", limit, helper)).ok).toBe(true);
		expect(calls).toBe(1);
	});

	it.skipIf(!existsSync(join(realOmp, "package.json")))("finds a whole word with installed pi-natives", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-search-real-"));
		const helper = stock(realOmp);
		try {
			await writeFile(join(dir, "found.ts"), "AXb\na.bcd\nA.B\n");
			await writeFile(join(dir, "other.md"), "a.b\n");
			const request = { ...base, wholeWord: true, glob: "*.ts" };
			const result = await searchWorkspace(dir, request, helper.request.bind(helper));
			expect(result).toMatchObject({
				ok: true,
				files: 1,
				limited: false,
				matches: [{ path: "found.ts", line: 3, text: "A.B" }],
			});
		} finally {
			await helper.stop();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
