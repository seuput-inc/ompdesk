import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import compatibility from "../src/shared/app-compatibility.json";
import { cargoEnv, cargoPath, rustcPath } from "./cargo";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TAURI_DIR = path.join(REPO_ROOT, "native/ompdesk/crates/tauri-shell");
export const RECORD_NAME = "ompdesk-tauri.build.json";
/** The cargo feature that compiles the embedded WebDriver server; only a test build has it, never a released binary. */
export const TEST_AUTOMATION = "test-automation";

export interface TauriBuildRecord {
	engine: "tauri";
	platform: string;
	arch: string;
	binary: string;
	launcher?: string;
	files: Record<string, string>;
	sourceSha256: string;
	rustc: string;
	features: string[];
}

function filesUnder(root: string, relative = "", files: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
		if (["target", ".git"].includes(entry.name)) continue;
		// tauri-build writes the capability schemas into the crate's own `gen/` while it compiles: output, not source.
		if (relative === "" && entry.name === "gen") continue;
		const name = path.join(relative, entry.name);
		if (entry.isDirectory()) filesUnder(root, name, files);
		else if (entry.isFile()) files.push(name);
	}
	return files;
}

function sha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Every source file the host is built from, by repository path, with its hash. */
function sourceFiles(): Map<string, string> {
	const files = new Map<string, string>();
	// `crates/sysproxy` is a member of the core's workspace, whose manifest gives it its edition and lints.
	for (const single of ["native/ompdesk/rust-toolchain.toml", "native/ompdesk/Cargo.toml"])
		files.set(single, sha256(path.join(REPO_ROOT, single)));
	for (const root of [
		TAURI_DIR,
		...["../shell", "../shell-preview", "../sysproxy"].map(dir => path.join(TAURI_DIR, dir)),
	]) {
		for (const name of filesUnder(root).sort()) {
			const file = path.join(root, name);
			files.set(path.relative(REPO_ROOT, file).replaceAll(path.sep, "/"), sha256(file));
		}
	}
	return files;
}

function appVersion(): string {
	return (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
}

export function sourceSha256(files = sourceFiles()): string {
	const digest = createHash("sha256");
	for (const [name, hash] of files) digest.update(`${name}\0${hash}\0`);
	digest.update(fs.readFileSync(fileURLToPath(import.meta.url)));
	digest.update(JSON.stringify(compatibility));
	// tauri.conf.json takes the app's version from package.json into the host's Windows version resource.
	digest.update(appVersion());
	return digest.digest("hex");
}

function changedSources(before: Map<string, string>, after: Map<string, string>): string[] {
	const names = new Set([...before.keys(), ...after.keys()]);
	return [...names].filter(name => before.get(name) !== after.get(name)).sort();
}

export function stagedDir(): string {
	return path.join(REPO_ROOT, "resources/ompdesk-tauri", `${process.platform}-${process.arch}`);
}

export function checkTauri(target = stagedDir(), testAutomation = false): TauriBuildRecord {
	const record = JSON.parse(fs.readFileSync(path.join(target, RECORD_NAME), "utf8")) as TauriBuildRecord;
	const features = testAutomation ? [TEST_AUTOMATION] : [];
	if (JSON.stringify(record.features) !== JSON.stringify(features)) {
		throw new Error(
			`The staged Tauri host was built with features [${record.features ?? "unrecorded"}], not [${features}]`,
		);
	}
	if (
		record.engine !== "tauri" ||
		record.platform !== process.platform ||
		record.arch !== process.arch ||
		record.sourceSha256 !== sourceSha256()
	) {
		throw new Error("The staged Tauri host does not match this checkout and platform");
	}
	const expected = [process.platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell"];
	if (process.platform === "darwin") expected.push("ompdesk-launcher");
	if (JSON.stringify(Object.keys(record.files).sort()) !== JSON.stringify(expected.sort())) {
		throw new Error("The Tauri build record contains unexpected runtime files");
	}
	const actual = fs
		.readdirSync(target)
		.filter(name => name !== RECORD_NAME)
		.sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error("The Tauri staging folder contains unrecorded runtime files");
	}
	for (const name of expected) {
		if (!fs.lstatSync(path.join(target, name)).isFile()) throw new Error(`Not a regular staged runtime: ${name}`);
		if (sha256(path.join(target, name)) !== record.files[name]) {
			throw new Error(`The staged Tauri runtime changed: ${name}`);
		}
	}
	return record;
}

export async function buildTauri(testAutomation = false): Promise<string> {
	if (!["darwin", "win32"].includes(process.platform)) throw new Error("OMPdesk ships on macOS and Windows only");
	const cargo = cargoPath(TAURI_DIR);
	if (!cargo) throw new Error("Rust is required to build the Tauri host");
	const targetDir = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(TAURI_DIR, "target"));
	const bins = ["ompdesk-tauri-shell", ...(process.platform === "darwin" ? ["ompdesk-launcher"] : [])];
	const sourcesBefore = sourceFiles();
	const sourceBefore = sourceSha256(sourcesBefore);
	const env = {
		...cargoEnv(cargo),
		CARGO_TARGET_DIR: targetDir,
		...(process.platform === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: compatibility.minimumMacOS } : {}),
	};
	const features = testAutomation ? [TEST_AUTOMATION] : [];
	const args = ["build", "--locked", "--release", ...features.flatMap(name => ["--features", name])];
	const child = Bun.spawn([cargo, ...args, ...bins.flatMap(name => ["--bin", name])], {
		cwd: TAURI_DIR,
		env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await child.exited) !== 0) throw new Error("Tauri host compilation failed");
	const target = stagedDir();
	fs.mkdirSync(target, { recursive: true });
	const binary = process.platform === "win32" ? "ompdesk-shell.exe" : "ompdesk-shell";
	const files: Record<string, string> = {};
	const changed = changedSources(sourcesBefore, sourceFiles());
	if (changed.length > 0)
		throw new Error(`Tauri sources changed during compilation; no build was staged: ${changed.join(", ")}`);
	for (const name of bins) {
		const built = path.join(targetDir, "release", `${name}${process.platform === "win32" ? ".exe" : ""}`);
		const destination = name === "ompdesk-tauri-shell" ? binary : name;
		const output = path.join(target, destination);
		fs.copyFileSync(built, output);
		fs.chmodSync(output, 0o755);
		files[destination] = sha256(output);
	}
	const version = Bun.spawnSync([rustcPath(cargo), "--version"], { env });
	if (version.exitCode !== 0) throw new Error("Could not identify the compiler used for the Tauri host");
	const record: TauriBuildRecord = {
		engine: "tauri",
		platform: process.platform,
		arch: process.arch,
		binary,
		...(process.platform === "darwin" ? { launcher: "ompdesk-launcher" } : {}),
		files,
		sourceSha256: sourceBefore,
		rustc: new TextDecoder().decode(version.stdout).trim(),
		features,
	};
	fs.writeFileSync(path.join(target, RECORD_NAME), `${JSON.stringify(record, null, "\t")}\n`);
	return target;
}

if (import.meta.main) {
	const testAutomation = process.argv.includes("--test-automation");
	if (process.argv.includes("--check")) console.log(checkTauri(stagedDir(), testAutomation));
	else console.log(await buildTauri(testAutomation));
}
