import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cargoEnv, cargoPath, rustcPath } from "./cargo";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TAURI_DIR = path.join(REPO_ROOT, "native/ompdesk/crates/tauri-shell");
export const RECORD_NAME = "ompdesk-tauri.build.json";

export interface TauriBuildRecord {
	engine: "tauri";
	platform: string;
	arch: string;
	binary: string;
	launcher?: string;
	files: Record<string, string>;
	sourceSha256: string;
	rustc: string;
}

function filesUnder(root: string, relative = "", files: string[] = []): string[] {
	for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
		if (["target", ".git"].includes(entry.name)) continue;
		const name = path.join(relative, entry.name);
		if (entry.isDirectory()) filesUnder(root, name, files);
		else if (entry.isFile()) files.push(name);
	}
	return files;
}

function sha256(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function sourceSha256(): string {
	const digest = createHash("sha256");
	for (const root of [TAURI_DIR, path.join(TAURI_DIR, "../shell")]) {
		for (const name of filesUnder(root).sort()) {
			digest.update(path.relative(REPO_ROOT, path.join(root, name)).replaceAll(path.sep, "/"));
			digest.update("\0");
			digest.update(fs.readFileSync(path.join(root, name)));
			digest.update("\0");
		}
	}
	digest.update(fs.readFileSync(fileURLToPath(import.meta.url)));
	return digest.digest("hex");
}

export function stagedDir(): string {
	return path.join(REPO_ROOT, "resources/ompdesk-tauri", `${process.platform}-${process.arch}`);
}

export function checkTauri(target = stagedDir()): TauriBuildRecord {
	const record = JSON.parse(fs.readFileSync(path.join(target, RECORD_NAME), "utf8")) as TauriBuildRecord;
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

export async function buildTauri(): Promise<string> {
	if (!["darwin", "win32"].includes(process.platform)) throw new Error("OMPdesk ships on macOS and Windows only");
	const cargo = cargoPath(TAURI_DIR);
	if (!cargo) throw new Error("Rust is required to build the Tauri host");
	const targetDir = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(TAURI_DIR, "target"));
	const bins = ["ompdesk-tauri-shell", ...(process.platform === "darwin" ? ["ompdesk-launcher"] : [])];
	const sourceBefore = sourceSha256();
	const env = { ...cargoEnv(cargo), CARGO_TARGET_DIR: targetDir };
	const child = Bun.spawn([cargo, "build", "--locked", "--release", ...bins.flatMap(name => ["--bin", name])], {
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
	if (sourceSha256() !== sourceBefore)
		throw new Error("Tauri sources changed during compilation; no build was staged");
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
	};
	fs.writeFileSync(path.join(target, RECORD_NAME), `${JSON.stringify(record, null, "\t")}\n`);
	return target;
}

if (import.meta.main) {
	if (process.argv.includes("--check")) console.log(checkTauri());
	else console.log(await buildTauri());
}
