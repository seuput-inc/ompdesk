/**
 * Build OMPdesk's own Rust (the cargo workspace in `native/ompdesk/`) for this machine and put it where the app, the
 * tests and packaging read it:
 *
 *   bun run build:native
 *
 * `cargo build --locked --release` over the workspace, then each of `BINARIES` as
 * `resources/ompdesk-bin/<platform>-<arch>/<name>[.exe]` and next to them `ompdesk.build.json`, the record of THIS
 * build (each binary's SHA-256, the SHA-256 of the sources it was built from, rustc, when). Both are gitignored. The
 * packaging check (`scripts/after-pack.cjs`) holds the shipped bytes to the record.
 *
 * Every binary is built on its own host (release.yml's `mac` and `win` jobs; Linux only for the tests CI runs
 * there). Rust is required: without `cargo` this says how to get it and exits 1.
 *
 *   bun run build:native -- --check
 *
 * builds nothing: it holds the staged binaries to the record and the record to the current sources; any mismatch
 * exits 1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnv, cargoPath, rustcPath } from "./cargo";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_DIR = path.join(REPO_ROOT, "native", "ompdesk");
export const BIN_ROOT = path.join(REPO_ROOT, "resources", "ompdesk-bin");
export const BUILD_MANIFEST = "ompdesk.build.json";
/** The executables the workspace ships, by cargo binary name. */
export const BINARIES = ["ompdesk", "ompdesk-core"] as const;
export type NativeBinary = (typeof BINARIES)[number];

export interface NativeBuildRecord {
	/** File name → SHA-256 of the staged bytes. */
	binaries: Record<string, string>;
	/** SHA-256 of the native release build's source files and recipe. */
	sourceSha256: string;
	platform: string;
	arch: string;
	rustc: string;
	builtAt: string;
	buildSeconds: number;
}

export const binaryFile = (name: NativeBinary, platform: string = process.platform): string =>
	platform === "win32" ? `${name}.exe` : name;

/** Where this machine's build is staged. */
export const stagedDir = (): string => path.join(BIN_ROOT, `${process.platform}-${process.arch}`);

class BuildError extends Error {}

// Cargo does not compile integration tests or these three independent shell workspaces into either binary.
const SEPARATE_CRATES = ["shell", "shell-preview", "tauri-shell"];

function sourceFiles(root: string): string[] {
	const files = [
		"scripts/build-native.ts",
		"scripts/cargo.ts",
		"resources/gui-bridge/wsl/probe-tools.sh",
		"src/shared/omp-minimum.json",
	];
	function walk(dir: string): void {
		for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
			if (entry.name === ".DS_Store" || entry.name === "target") continue;
			const file = `${dir}/${entry.name}`;
			if (dir === "native/ompdesk/crates" && SEPARATE_CRATES.includes(entry.name)) continue;
			if (entry.name === "tests" && /^native\/ompdesk\/crates\/[^/]+$/.test(dir)) continue;
			if (entry.isDirectory()) walk(file);
			else files.push(file);
		}
	}
	walk("native/ompdesk");
	for (const dir of [".cargo", "native/.cargo"]) {
		if (fs.existsSync(path.join(root, dir))) walk(dir);
	}
	return files.sort();
}

/** The cache lookup and the staged record use the same paths, bytes and build settings. */
export function sourceSha256(root = REPO_ROOT): string {
	const hash = createHash("sha256");
	for (const file of sourceFiles(root)) {
		hash.update(`${file}\0`);
		hash.update(fs.readFileSync(path.join(root, file)));
		hash.update("\0");
	}
	const cargoEnvKey = /^CARGO_(BUILD_|PROFILE_|TARGET_|ENCODED_RUSTFLAGS$)/;
	const compilerEnvKey =
		/^(RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_TOOLCHAIN|SDKROOT|MACOSX_DEPLOYMENT_TARGET|CC|CFLAGS|LDFLAGS|ImageOS|ImageVersion)$/;
	for (const key of Object.keys(process.env).sort()) {
		if (cargoEnvKey.test(key) || compilerEnvKey.test(key)) hash.update(`${key}\0${process.env[key]}\0`);
	}
	return hash.digest("hex");
}

/** Refuse to cache a binary if a path dependency or include! starts reading outside our fingerprint. */
export function checkCompilerInputs(root = REPO_ROOT): void {
	const workspace = path.join(root, "native/ompdesk");
	const files = new Set(sourceFiles(root));
	for (const name of BINARIES) {
		const depInfo = fs.readFileSync(path.join(workspace, "target", "release", `${name}.d`), "utf8").trimEnd();
		const split = depInfo.indexOf(": ");
		if (split < 0) throw new BuildError(`missing Cargo dependencies for ${name}`);
		for (const escaped of depInfo.slice(split + 2).split(/(?<!\\) /)) {
			const input = escaped.replaceAll("\\ ", " ");
			const file = path.relative(root, path.resolve(workspace, input)).split(path.sep).join("/");
			if (!files.has(file))
				throw new BuildError(`${name} compiled ${file}, missing from the native build fingerprint`);
		}
	}
}

const sha256 = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Holds the staged binaries to their record and the record to this checkout's sources. */
export function checkNative(): NativeBuildRecord {
	const target = stagedDir();
	const manifest = path.join(target, BUILD_MANIFEST);
	if (!fs.existsSync(manifest)) throw new BuildError(`${path.relative(REPO_ROOT, manifest)} is missing.`);
	const record = JSON.parse(fs.readFileSync(manifest, "utf8")) as NativeBuildRecord;
	if (record.platform !== process.platform || record.arch !== process.arch)
		throw new BuildError(
			`the build record is for ${record.platform}-${record.arch}, not ${process.platform}-${process.arch}.`,
		);
	if (record.sourceSha256 !== sourceSha256())
		throw new BuildError("the binaries were built from other sources than this checkout's native/ompdesk.");
	for (const name of BINARIES) {
		const file = path.join(target, binaryFile(name));
		if (!fs.existsSync(file)) throw new BuildError(`${path.relative(REPO_ROOT, file)} is missing.`);
		const actual = sha256(file);
		if (actual !== record.binaries[binaryFile(name)])
			throw new BuildError(`${binaryFile(name)} hashes to ${actual}; its build record expects another.`);
	}
	return record;
}

/**
 * Builds the workspace and stages its binaries; returns the folder that holds them. cargo decides what is stale, so
 * a second call costs a fraction of a second. `quiet` keeps cargo's progress out of a test run's output.
 */
export function buildNative(options: { quiet?: boolean } = {}): string {
	const cargo = cargoPath(NATIVE_DIR);
	if (!cargo)
		throw new BuildError(
			"Rust is not installed (no `cargo` on PATH or in ~/.cargo/bin). OMPdesk's own native code needs it: install it " +
				"from https://rustup.rs (the toolchain in native/ompdesk/rust-toolchain.toml is picked up automatically) and " +
				"run `bun run build:native` again.",
		);
	const source = sourceSha256();
	const started = Date.now();
	const run = spawnSync(cargo, ["build", "--locked", "--release", "--workspace"], {
		cwd: NATIVE_DIR,
		env: { ...cargoEnv(cargo), CARGO_BUILD_DEP_INFO_BASEDIR: NATIVE_DIR },
		stdio: options.quiet ? ["ignore", "ignore", "pipe"] : "inherit",
		encoding: "utf8",
	});
	if (run.status !== 0)
		throw new BuildError(`cargo build failed (${run.status ?? run.signal}).${run.stderr ? `\n${run.stderr}` : ""}`);
	checkCompilerInputs();
	if (source !== sourceSha256())
		throw new BuildError("native build inputs changed during compilation; rerun the build.");
	const target = stagedDir();
	fs.mkdirSync(target, { recursive: true });
	const binaries: Record<string, string> = {};
	for (const name of BINARIES) {
		const file = binaryFile(name);
		const built = path.join(NATIVE_DIR, "target", "release", file);
		if (!fs.existsSync(built)) throw new BuildError(`${built} was not produced.`);
		const bytes = fs.readFileSync(built);
		binaries[file] = createHash("sha256").update(bytes).digest("hex");
		const staged = path.join(target, file);
		// Same bytes already staged: leave the file alone, so a run in another process keeps executing it.
		if (fs.existsSync(staged) && sha256(staged) === binaries[file]) continue;
		const temp = path.join(target, `${file}.tmp-${process.pid}`);
		try {
			fs.writeFileSync(temp, bytes, { mode: 0o755 });
			fs.chmodSync(temp, 0o755);
			fs.renameSync(temp, staged);
		} finally {
			fs.rmSync(temp, { force: true });
		}
	}
	const record: NativeBuildRecord = {
		binaries,
		sourceSha256: source,
		platform: process.platform,
		arch: process.arch,
		rustc: execFileSync(rustcPath(cargo), ["--version"], { cwd: NATIVE_DIR, encoding: "utf8" }).trim(),
		builtAt: new Date().toISOString(),
		buildSeconds: Math.round((Date.now() - started) / 1000),
	};
	const manifest = path.join(target, BUILD_MANIFEST);
	const previous = fs.existsSync(manifest)
		? (JSON.parse(fs.readFileSync(manifest, "utf8")) as NativeBuildRecord)
		: null;
	const same =
		previous !== null &&
		previous.sourceSha256 === record.sourceSha256 &&
		JSON.stringify(previous.binaries) === JSON.stringify(record.binaries);
	if (!same) fs.writeFileSync(manifest, `${JSON.stringify(record, null, "\t")}\n`);
	return target;
}

/**
 * The staged binaries for a test or a spec that runs them: what is staged when it is this checkout's build
 * (`checkNative`, no cargo), else a build. Returns the folder that holds them.
 */
export function ensureNative(): string {
	try {
		checkNative();
		return stagedDir();
	} catch (error) {
		if (!(error instanceof BuildError)) throw error;
		return buildNative({ quiet: true });
	}
}

if (import.meta.main) {
	try {
		if (process.argv.includes("--source-sha256")) {
			console.log(sourceSha256());
		} else if (process.argv.includes("--check")) {
			const record = checkNative();
			console.log(
				`checked ${path.relative(REPO_ROOT, stagedDir())} (${Object.keys(record.binaries).join(", ")}; built ${record.builtAt})`,
			);
		} else if (process.argv.includes("--ensure")) {
			console.log(path.relative(REPO_ROOT, ensureNative()));
		} else {
			const target = buildNative();
			const sizes = BINARIES.map(name => {
				const file = binaryFile(name);
				return `${file} ${fs.statSync(path.join(target, file)).size} bytes`;
			});
			console.log(`built ${path.relative(REPO_ROOT, target)} (${sizes.join(", ")})`);
		}
	} catch (error) {
		if (!(error instanceof BuildError)) throw error;
		console.error(`build:native: ${error.message}`);
		process.exit(1);
	}
}
