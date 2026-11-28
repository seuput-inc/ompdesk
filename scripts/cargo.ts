/** Where the scripts that build the repository's Rust (native/memory, native/ompdesk) find cargo. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const win = process.platform === "win32";

function findExe(name: string, extra: string[] = []): string | null {
	const exe = win ? `${name}.exe` : name;
	const candidates = [
		...(process.env.PATH ?? "").split(path.delimiter).map(dir => (dir ? path.join(dir, exe) : "")),
		...extra.map(dir => path.join(dir, exe)),
		path.join(os.homedir(), ".cargo", "bin", exe),
	];
	return candidates.find(file => file && fs.existsSync(file)) ?? null;
}

/**
 * `cargo` for the build folder `cwd` (the folder holding rust-toolchain.toml). When rustup is reachable the
 * toolchain file is honoured by asking rustup for the real binary (a non-rustup cargo first on PATH, such as
 * Homebrew's, ignores the file). Without rustup: `cargo` on PATH, else `~/.cargo/bin`.
 */
export function cargoPath(cwd?: string): string | null {
	const plain = findExe("cargo");
	const rustup = findExe("rustup", plain ? [path.dirname(plain)] : []);
	if (!rustup) return plain;
	try {
		const out = execFileSync(rustup, ["which", "cargo"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const found = out.split(/\r?\n/).pop() ?? "";
		if (found && fs.existsSync(found)) return found;
	} catch (error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
		throw new Error(
			`rustup could not resolve cargo for ${cwd ?? process.cwd()} (the toolchain pinned in its rust-toolchain.toml is probably not installed). ` +
				`Install it yourself with \`rustup toolchain install\` there; this script does not install toolchains.${stderr ? `\n${stderr}` : ""}`,
		);
	}
	return plain;
}

/** The `rustc` beside `cargo`. */
export function rustcPath(cargo: string): string {
	return path.join(path.dirname(cargo), win ? "rustc.exe" : "rustc");
}

/** The environment to run `cargo` with: its own folder first on PATH, so a toolchain binary found through rustup reaches its rustc. */
export function cargoEnv(cargo: string): NodeJS.ProcessEnv {
	return { ...process.env, PATH: `${path.dirname(cargo)}${path.delimiter}${process.env.PATH ?? ""}` };
}

/** A gate verdict needs the pushed workspace's exact toolchain, not the build scripts' PATH fallback. */
export function pinnedClippy(workspace: string) {
	const doc = Bun.TOML.parse(fs.readFileSync(path.join(workspace, "rust-toolchain.toml"), "utf8"));
	const toolchain = "toolchain" in doc ? doc.toolchain : undefined;
	const channel = toolchain && typeof toolchain === "object" && "channel" in toolchain ? toolchain.channel : undefined;
	if (typeof channel !== "string" || !/^\d+\.\d+\.\d+$/.test(channel))
		throw new Error("rust-toolchain.toml does not pin an exact Rust release");
	const rustup = findExe("rustup");
	if (!rustup) throw new Error(`cannot verify Rust ${channel} without rustup; not using PATH cargo`);
	const pin = { RUSTUP_AUTO_INSTALL: "0", RUSTUP_TOOLCHAIN: channel };
	let cargo: string;
	try {
		cargo = execFileSync(rustup, ["which", "--toolchain", channel, "cargo"], {
			cwd: workspace,
			env: { ...process.env, ...pin },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (error) {
		throw new Error(`no installed cargo for Rust ${channel}: ${String(error)}`);
	}
	if (!path.isAbsolute(cargo)) throw new Error(`rustup did not return a cargo path for Rust ${channel}`);
	const sibling = (name: string) => path.join(path.dirname(cargo), win ? `${name}.exe` : name);
	const rustc = rustcPath(cargo);
	const clippy = sibling("cargo-clippy");
	const driver = sibling("clippy-driver");
	const env = {
		...cargoEnv(cargo),
		...pin,
		CARGO: cargo,
		RUSTC: rustc,
		RUSTFMT: sibling("rustfmt"),
		RUSTC_WRAPPER: "",
		RUSTC_WORKSPACE_WRAPPER: "",
		CLIPPY_DRIVER_PATH: driver,
		CARGO_NET_OFFLINE: "true",
	};
	const version = (file: string, flag = "--version") => {
		try {
			return execFileSync(file, [flag], {
				cwd: workspace,
				env,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim();
		} catch (error) {
			throw new Error(`Rust ${channel} cannot run ${path.basename(file)}: ${String(error)}`);
		}
	};
	const rust = version(rustc, "-vV");
	if (!rust.split(/\r?\n/).includes(`release: ${channel}`) || version(cargo).split(" ")[1] !== channel)
		throw new Error(`rustup's rustc and cargo do not both report the pinned release ${channel}`);
	const commit = /^commit-hash: ([0-9a-f]{40})\r?$/m.exec(rust)?.[1];
	const frontend = version(clippy);
	const revision = /^clippy \S+ \(([0-9a-f]{7,40}) /.exec(frontend)?.[1];
	if (!revision || !commit?.startsWith(revision) || version(driver) !== frontend)
		throw new Error(`cargo-clippy and clippy-driver do not match rustc ${channel} (${commit ?? "unknown commit"})`);
	return { channel, cargo, clippy, fmt: sibling("cargo-fmt"), env };
}
