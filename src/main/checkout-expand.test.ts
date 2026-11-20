import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitSync, initRepo } from "./local/git/test-repos";

const BRIDGE = path.resolve(__dirname, "../../resources/gui-bridge/modes");

/** The claims a session's `bash` call takes, through the bridge's real expansion (Bun's glob, so in bun). */
async function claimsOf(repo: string, command: string): Promise<string[]> {
	const script = path.join(repo, "..", "claims.ts");
	await fs.writeFile(
		script,
		[
			`import * as fs from "node:fs";`,
			`import { CheckoutLedger } from ${JSON.stringify(path.join(BRIDGE, "checkout-peers-core.ts"))};`,
			`import { expandGlob } from ${JSON.stringify(path.join(BRIDGE, "checkout-expand.ts"))};`,
			"const host = {",
			"\trealpath: (p: string) => fs.realpathSync.native(p),",
			"\tisDirectory: (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },",
			"\texpand: expandGlob,",
			"};",
			"const ledger = new CheckoutLedger();",
			`ledger.call("bash", { command: ${JSON.stringify(command)} }, ${JSON.stringify(repo)}, undefined, host, "c1");`,
			"console.log(JSON.stringify(ledger.claims.files));",
		].join("\n"),
	);
	return JSON.parse(execFileSync("bun", [script], { encoding: "utf8" })) as string[];
}

async function crate(): Promise<string> {
	const repo = path.join(await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "claims-expand-"))), "repo");
	await fs.mkdir(path.join(repo, "src"), { recursive: true });
	await initRepo(repo);
	await fs.writeFile(path.join(repo, ".gitignore"), "target/\n");
	await fs.writeFile(path.join(repo, "Cargo.toml"), '[package]\nname = "x"\n');
	await fs.writeFile(path.join(repo, "src", "lib.rs"), "pub fn x() {}\n");
	gitSync(repo, "add", ".");
	gitSync(repo, "commit", "-qm", "crate");
	await fs.mkdir(path.join(repo, "target", "debug", "deps"), { recursive: true });
	for (let i = 0; i < 20; i++) await fs.writeFile(path.join(repo, "target", "debug", "deps", `x-${i}.rlib`), "");
	return repo;
}

describe("the files a formatter on a folder claims", () => {
	it("are the crate's own files: cargo fmt --all claims no build output git ignores", {
		timeout: 30_000,
	}, async () => {
		const repo = await crate();
		const files = await claimsOf(repo, "cargo fmt --all");
		expect(files.filter(file => file.includes("/target/"))).toEqual([]);
		for (const own of ["/Cargo.toml", "/src/lib.rs", "/.gitignore"])
			expect(files.some(file => file.endsWith(own))).toBe(true);
	});

	it("are every match outside a repository, where git cannot say what is ignored", { timeout: 30_000 }, async () => {
		const dir = path.join(await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "claims-expand-"))), "plain");
		await fs.mkdir(path.join(dir, "target"), { recursive: true });
		await fs.writeFile(path.join(dir, ".gitignore"), "target/\n");
		await fs.writeFile(path.join(dir, "target", "a.o"), "");
		expect((await claimsOf(dir, "cargo fmt --all")).some(file => file.endsWith("/target/a.o"))).toBe(true);
	});
});
