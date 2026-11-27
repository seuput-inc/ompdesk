import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitSync, initRepo } from "../src/main/local/git/test-repos";
import {
	gatePush,
	isGated,
	needsFixTests,
	parsePushRefs,
	planGate,
	probesInPush,
	rangeBase,
	syncTree,
	withMutex,
	worktreeHolds,
} from "./pre-push-gate";

const SHA_A = "a".repeat(40);
const ZERO = "0".repeat(40);

describe("parsePushRefs", () => {
	it("reads git's four-field lines and skips deletions and tags", () => {
		const refs = parsePushRefs(
			`refs/heads/main ${SHA_A} refs/heads/main ${ZERO}\n(delete) ${ZERO} refs/heads/old ${SHA_A}\nrefs/tags/v1 ${SHA_A} refs/tags/v1 ${ZERO}\n`,
		);
		expect(refs.map(ref => ref.localRef)).toEqual(["refs/heads/main", "(delete)", "refs/tags/v1"]);
		expect(refs.filter(isGated).map(ref => ref.localRef)).toEqual(["refs/heads/main"]);
	});

	it("leaves an archive ref unchecked, and a probe branch out of the fix-commit rule only", () => {
		const [archive, probe, branch, main] = parsePushRefs(
			[
				`${SHA_A} ${SHA_A} refs/archive/2026-11/omp/agent/old ${ZERO}`,
				`HEAD ${SHA_A} refs/heads/probe/red-test ${ZERO}`,
				`HEAD ${SHA_A} refs/heads/omp/agent/fix ${ZERO}`,
				`refs/heads/main ${SHA_A} refs/heads/main ${SHA_A}`,
			].join("\n"),
		);
		expect([archive, probe, branch, main].map(isGated)).toEqual([false, true, true, true]);
		expect([probe, branch, main].map(needsFixTests)).toEqual([false, true, true]);
	});
});

describe("planGate", () => {
	it("needs no TypeScript or captured-table checks for docs, native Rust and workflows", () => {
		const plan = planGate([
			"README.md",
			"docs/a.md",
			"native/ompdesk/crates/core/src/lib.rs",
			".github/workflows/ci.yml",
		]);
		expect(plan).toEqual({ biome: [], surfaces: null, types: false, budget: false, tables: false });
	});

	it("checks ompdesk_app's tables when a commit touches the Rust tables or their captured copy", () => {
		const app = "native/ompdesk/crates/core/src/agentctl/app";
		for (const file of ["captured/meta.json", "channels.rs", "catalog.rs", "settings.rs"])
			expect(planGate([`${app}/${file}`]).tables).toBe(true);
		expect(planGate([`${app}/control.rs`, "src/main/a.ts"]).tables).toBe(false);
	});

	it("runs every static check for a renderer source and the budget for it", () => {
		expect(planGate(["src/renderer/components/Row.tsx", "docs/a.md"])).toEqual({
			biome: ["src/renderer/components/Row.tsx"],
			surfaces: { only: ["src/renderer/components/Row.tsx"] },
			types: true,
			budget: true,
			tables: false,
		});
	});

	it("gives the surface policy only the changed files it reads, the whole tree when a lint changed", () => {
		expect(
			planGate(["src/main/a.ts", "resources/gui-bridge/b.ts", "e2e/c.ts", "src/renderer/x.css"]).surfaces,
		).toEqual({
			only: ["resources/gui-bridge/b.ts", "src/main/a.ts"],
		});
		expect(planGate(["e2e/c.ts"]).surfaces).toBeNull();
		expect(planGate(["scripts/lint-ime.mjs", "src/main/a.ts"]).surfaces).toEqual({ only: null });
		expect(planGate(["scripts/lint-duplicate-rules-allow.json"]).surfaces).toEqual({ only: null });
	});

	it("skips the typecheck for a range that changed no TypeScript, JSON it imports or configuration", () => {
		expect(planGate(["scripts/lint-x.mjs", "src/renderer/styles/global.css", "resources/a.json"]).types).toBe(false);
		expect(planGate(["src/shared/a.ts"]).types).toBe(true);
		expect(planGate(["e2e/a.e2e.ts"]).types).toBe(true);
		expect(planGate(["src/main/table.json"]).types).toBe(true);
		expect(planGate(["tsconfig.json"]).types).toBe(true);
		expect(planGate(["package.json"]).types).toBe(true);
		expect(planGate(["bun.lock"]).types).toBe(true);
	});

	it("skips the budget for main-process code and keeps it for shared code", () => {
		expect(planGate(["src/main/a.ts"]).budget).toBe(false);
		expect(planGate(["src/shared/a.ts"]).budget).toBe(true);
		expect(planGate(["src/renderer/styles/global.css"])).toMatchObject({
			types: false,
			surfaces: null,
			budget: true,
		});
	});
});

describe("a probe branch never lands on main", () => {
	let repo = "";
	const commit = (file: string, message: string) => {
		fs.writeFileSync(path.join(repo, file), `${message}\n`);
		gitSync(repo, "add", "-A");
		gitSync(repo, "commit", "-q", "-m", message);
		return gitSync(repo, "rev-parse", "HEAD");
	};
	const toMain = (localSha: string, remoteSha: string) => ({
		localRef: "HEAD",
		localSha,
		remoteRef: "refs/heads/main",
		remoteSha,
	});
	beforeEach(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-probe-"));
		await initRepo(repo);
	});
	afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

	it("refuses a push to main that carries a probe's test-only commit, and lets the fix with its own test through", () => {
		const base = commit("a.ts", "first");
		gitSync(repo, "checkout", "-q", "-b", "probe/red-test");
		const red = commit("a.test.ts", "test: the bug, before its fix");
		expect(probesInPush(repo, toMain(red, base), base)).toEqual(["refs/heads/probe/red-test"]);
		expect(probesInPush(repo, { ...toMain(red, base), remoteRef: "refs/heads/probe/red-test" }, base)).toEqual([]);

		gitSync(repo, "checkout", "-q", base);
		fs.writeFileSync(path.join(repo, "a.test.ts"), "test: the bug, before its fix\n");
		const fix = commit("a.ts", "fix: the bug, with its test");
		expect(probesInPush(repo, toMain(fix, base), base)).toEqual([]);
	});

	it("lets main take the commits a probe sits on: the branch's own work and a candidate branch main merges", () => {
		const base = commit("a.ts", "first");
		gitSync(repo, "checkout", "-q", "-b", "work");
		const work = commit("b.ts", "feat: the work");
		gitSync(repo, "checkout", "-q", "-b", "probe/on-work");
		commit("b.test.ts", "test: a red check on the work");
		expect(probesInPush(repo, toMain(work, base), base)).toEqual([]);

		gitSync(repo, "checkout", "-q", "-b", "rc", base);
		const candidate = commit("c.ts", "fix: in the candidate");
		gitSync(repo, "checkout", "-q", "-b", "probe/on-rc");
		commit("c.test.ts", "test: a red check on the candidate");
		gitSync(repo, "checkout", "-q", "work");
		gitSync(repo, "merge", "-q", "--no-ff", "-m", "merge the candidate", candidate);
		const merged = gitSync(repo, "rev-parse", "HEAD");
		expect(probesInPush(repo, toMain(merged, base), base)).toEqual([]);

		gitSync(repo, "merge", "-q", "--no-ff", "-m", "merge the probe", "probe/on-rc");
		const carried = gitSync(repo, "rev-parse", "HEAD");
		expect(probesInPush(repo, toMain(carried, base), base)).toEqual(["refs/heads/probe/on-rc"]);
	});
});

describe("the gate's copy of a pushed commit", () => {
	let repo = "";
	let tree = "";
	const commit = (message: string) => {
		gitSync(repo, "add", "-A");
		gitSync(repo, "commit", "-q", "-m", message);
		return gitSync(repo, "rev-parse", "HEAD");
	};
	const write = (file: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		fs.writeFileSync(path.join(repo, file), text);
	};
	beforeEach(async () => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-repo-"));
		tree = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-tree-"));
		await initRepo(repo);
	});
	afterEach(() => {
		fs.rmSync(repo, { recursive: true, force: true });
		fs.rmSync(tree, { recursive: true, force: true });
	});

	it("allows an unprovisioned push without calling it passed, and still refuses a failed check", async () => {
		for (const file of ["scripts/lint-fix-tests.mjs", "src/shared/git-env.ts"]) {
			fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
			fs.copyFileSync(path.resolve(file), path.join(repo, file));
		}
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			let base = commit("prepare checks");
			const lines: string[] = [];
			const push = (...refs: string[]) => gatePush(repo, path.join(repo, ".git"), refs.join("\n"));
			for (const [file, subject, status, summary] of [
				["note.md", "docs: note", 0, /^\[pre-push\] passed in /],
				["scripts/example.ts", "feat: example", 0, /^\[pre-push\] SKIPPED: .*Check CI/],
				["scripts/example.ts", "fix: missing test", 1, /^\[pre-push\] FAILED: refused/],
			] as const) {
				write(file, subject);
				const tip = commit(subject);
				const line = `HEAD ${tip} refs/heads/check-${lines.length} ${base}`;
				lines.push(line);
				expect(await push(line)).toBe(status);
				expect(log.mock.lastCall?.[0]).toMatch(summary);
				base = tip;
			}
			expect(await push(lines[1], lines[0])).toBe(0);
			expect(log.mock.lastCall?.[0]).toBe("[pre-push] push: SKIPPED");
			expect(await push(lines[1], lines[2])).toBe(1);
			expect(log.mock.lastCall?.[0]).toBe("[pre-push] push: FAILED");
		} finally {
			log.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32")("lints each pushed SHA with its own sources and installed Rust", () => {
		const src = "native/ompdesk/crates/demo/src/lib.rs";
		const pin = "native/ompdesk/rust-toolchain.toml";
		const bin = path.join(tree, "bin");
		const installed = path.join(tree, "1.2.3");
		const shared = path.join(tree, "shared-target");
		for (const dir of [bin, installed, shared]) fs.mkdirSync(dir);
		const exe = (dir: string, name: string, body: string) =>
			fs.writeFileSync(path.join(dir, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
		exe(bin, "rustup", '[ "$*" = "which --toolchain 1.2.3 cargo" ] && printf "%s/cargo\\n" "$INSTALLED"');
		for (const name of ["cargo", "rustc", "cargo-clippy", "clippy-driver"])
			exe(bin, name, 'echo "unexpected PATH tool" >&2; exit 42');
		exe(
			installed,
			"rustc",
			`echo "rustc 1.2.3"; if [ "$1" = -vV ]; then printf 'release: 1.2.3\\ncommit-hash: ${SHA_A}\\n'; fi`,
		);
		const clippyVersion = '[ "$1" != --version ] || { echo "clippy 0.1.2 (aaaaaaaaaa 2026-01-01)"; exit 0; }';
		exe(
			installed,
			"cargo",
			`case "$1" in
metadata) printf '{"packages":[{"name":"demo","manifest_path":"%s/crates/demo/Cargo.toml"}]}\\n' "$(pwd -P)";;
clean) [ "$*" = "clean --locked -p demo" ] && rm -f "$CARGO_BUILD_BUILD_DIR/fingerprint";;
--version) echo "cargo 1.2.3";;
*) exit 42;;
esac`,
		);
		exe(
			installed,
			"cargo-clippy",
			`${clippyVersion}
[ "$("\${RUSTC:-rustc}" --version)" = "rustc 1.2.3" ]
[ "$("\${CARGO:-cargo}" --version)" = "cargo 1.2.3" ]
[ "$CARGO_NET_OFFLINE" = true ]
exec "\${CLIPPY_DRIVER_PATH:-clippy-driver}" "$@"`,
		);
		exe(
			installed,
			"clippy-driver",
			`${clippyVersion}
src=crates/demo/src/lib.rs
cache="$CARGO_BUILD_BUILD_DIR/fingerprint"
mkdir -p "$CARGO_BUILD_BUILD_DIR"
if [ ! -f "$cache" ] || [ "$src" -nt "$cache" ]; then cp "$src" "$cache"; fi
grep -qx clean "$cache" || { echo "lint in $(cat "$cache")" >&2; exit 1; }`,
		);
		write(pin, '[toolchain]\nchannel = "1.2.3"\n');
		write(src, "base\n");
		const base = commit("prepare workspace");
		write(src, "older candidate\n");
		const older = commit("first candidate");
		write(src, "clean\n");
		const clean = commit("second candidate");
		write(src, "checkout\n");
		write(pin, '[toolchain]\nchannel = "4.5.6"\n');
		const checkout = commit("another toolchain");

		const script = `import { gatePush } from ${JSON.stringify(path.resolve("scripts/pre-push-gate.ts"))};
process.env.PATH = process.env.GATE_PATH;
process.exit(await gatePush(process.cwd(), process.cwd() + "/.git", process.env.PUSH_REF));`;
		const push = (sha: string, gatePath = `${bin}${path.delimiter}${process.env.PATH}`) =>
			spawnSync("bun", ["-e", script], {
				cwd: repo,
				env: {
					...process.env,
					HOME: tree,
					GATE_PATH: gatePath,
					PUSH_REF: `HEAD ${sha} refs/heads/probe/clippy ${base}`,
					INSTALLED: installed,
					OMPDESK_BUILD_LOCK_HELD: "1",
					RUSTUP_TOOLCHAIN: "stable",
					RUSTC: path.join(bin, "rustc"),
					CLIPPY_DRIVER_PATH: path.join(bin, "clippy-driver"),
					CARGO_TARGET_DIR: shared,
					CARGO_BUILD_BUILD_DIR: shared,
				},
				encoding: "utf8",
			});
		const good = push(clean);
		expect(good.status, good.stderr).toBe(0);
		expect(good.stdout).toContain("ok     clippy (demo; Rust 1.2.3)");
		const bad = push(older);
		expect(bad.status, bad.stdout).toBe(1);
		expect(bad.stderr).toContain("lint in older candidate");
		expect(fs.readdirSync(shared)).toEqual([]);
		const unavailable = push(checkout);
		expect(unavailable.status).toBe(0);
		expect(unavailable.stdout).toMatch(/SKIPPED clippy: .*Rust 4\.5\.6/);
		fs.unlinkSync(path.join(installed, "clippy-driver"));
		const missing = push(clean);
		expect(missing.status).toBe(0);
		expect(missing.stdout).toMatch(/SKIPPED clippy: .*1\.2\.3.*clippy-driver/);
		expect(missing.stdout).toContain("SKIPPED: local verification incomplete");
		exe(installed, "clippy-driver", 'echo "clippy 0.1.1 (bbbbbbbbbb 2025-01-01)"');
		const mismatched = push(clean);
		expect(mismatched.status).toBe(0);
		expect(mismatched.stdout).toMatch(/SKIPPED clippy: .*do not match rustc 1\.2\.3/);
		fs.unlinkSync(path.join(bin, "rustup"));
		for (const name of ["git", "tar"]) fs.symlinkSync(`/usr/bin/${name}`, path.join(bin, name));
		const plain = push(clean, bin);
		expect(plain.status).toBe(0);
		expect(plain.stdout).toMatch(/SKIPPED clippy: .*1\.2\.3.*without rustup/);
	});

	it("copies Rust workspace sources and imported JSON, not unrelated native code or docs", () => {
		write("src/a.ts", "export const a = 1;\n");
		write("native/x.rs", "fn main() {}\n");
		write("native/ompdesk/crates/core/src/lib.rs", "pub const PUSHED: bool = true;\n");
		write("native/crates/core/table.json", "{}\n");
		write("docs/d.md", "d\n");
		write("package.json", "{}\n");
		const sha = commit("first");
		syncTree(repo, tree, sha);
		expect(fs.readFileSync(path.join(tree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		expect(fs.existsSync(path.join(tree, "package.json"))).toBe(true);
		fs.writeFileSync(path.join(repo, "native/ompdesk/crates/core/src/lib.rs"), "bad edit\n");
		expect(worktreeHolds(repo, sha)).toBe(false);
		expect(fs.readFileSync(path.join(tree, "native/ompdesk/crates/core/src/lib.rs"), "utf8")).toBe(
			"pub const PUSHED: bool = true;\n",
		);
		expect(fs.existsSync(path.join(tree, "native/crates/core/table.json"))).toBe(true);
		expect(fs.existsSync(path.join(tree, "native/x.rs"))).toBe(false);
		expect(fs.existsSync(path.join(tree, "docs"))).toBe(false);
		write("native/crates/core/table.json", '{"a":1}\n');
		syncTree(repo, tree, commit("second"));
		expect(fs.readFileSync(path.join(tree, "native/crates/core/table.json"), "utf8")).toBe('{"a":1}\n');
	});

	it("runs in place only while the working tree holds the pushed commit's files", () => {
		write("src/a.ts", "a\n");
		const sha = commit("first");
		expect(worktreeHolds(repo, sha)).toBe(true);
		write("docs/notes.md", "someone's notes\n");
		expect(worktreeHolds(repo, sha)).toBe(true);
		write("src/a.ts", "a, edited\n");
		expect(worktreeHolds(repo, sha)).toBe(false);
		fs.writeFileSync(path.join(repo, "src/a.ts"), "a\n");
		write("src/untracked.ts", "x\n");
		expect(worktreeHolds(repo, sha)).toBe(false);
	});

	it("moves to the next commit by its differences and keeps the cache and the module link", () => {
		write("src/a.ts", "a1\n");
		write("src/gone.ts", "gone\n");
		const first = commit("first");
		syncTree(repo, tree, first);
		fs.writeFileSync(path.join(tree, ".gate.tsbuildinfo"), "cache");
		fs.symlinkSync(repo, path.join(tree, "node_modules"), "junction");
		write("src/a.ts", "a2\n");
		write("src/new.ts", "new\n");
		fs.rmSync(path.join(repo, "src/gone.ts"));
		const second = commit("second");
		syncTree(repo, tree, second);
		expect(fs.readFileSync(path.join(tree, "src/a.ts"), "utf8")).toBe("a2\n");
		expect(fs.existsSync(path.join(tree, "src/new.ts"))).toBe(true);
		expect(fs.existsSync(path.join(tree, "src/gone.ts"))).toBe(false);
		expect(fs.readFileSync(path.join(tree, ".gate.tsbuildinfo"), "utf8")).toBe("cache");
		expect(fs.lstatSync(path.join(tree, "node_modules")).isSymbolicLink()).toBe(true);
	});

	it("rebuilds from scratch when the commit it held is unknown", () => {
		write("src/a.ts", "a\n");
		const sha = commit("first");
		fs.mkdirSync(path.join(tree, "src"), { recursive: true });
		fs.writeFileSync(path.join(tree, "src/stale.ts"), "stale\n");
		fs.writeFileSync(path.join(tree, ".gate-sha"), `${SHA_A}\n`);
		syncTree(repo, tree, sha);
		expect(fs.existsSync(path.join(tree, "src/stale.ts"))).toBe(false);
		expect(fs.existsSync(path.join(tree, "src/a.ts"))).toBe(true);
	});

	it("measures a pushed range from the remote's tip when it is known, else from origin/main", () => {
		const base = gitSync(repo, "rev-parse", "HEAD");
		write("src/a.ts", "a\n");
		const head = commit("next");
		const ref = { localRef: "refs/heads/x", localSha: head, remoteRef: "refs/heads/x", remoteSha: base };
		expect(rangeBase(repo, ref)).toBe(base);
		gitSync(repo, "update-ref", "refs/remotes/origin/main", base);
		expect(rangeBase(repo, { ...ref, remoteSha: ZERO })).toBe(base);
		expect(rangeBase(repo, { ...ref, remoteSha: SHA_A })).toBe(base);
	});
});

describe("withMutex", () => {
	it("takes over a lock whose holder is gone and frees it afterwards", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-lock-"));
		const lock = path.join(dir, "lock");
		fs.mkdirSync(lock);
		fs.writeFileSync(path.join(lock, "pid"), "2147483646");
		let waited = false;
		const result = await withMutex(
			lock,
			async () => fs.existsSync(lock),
			() => {
				waited = true;
			},
		);
		expect(result).toBe(true);
		expect(waited).toBe(false);
		expect(fs.existsSync(lock)).toBe(false);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
