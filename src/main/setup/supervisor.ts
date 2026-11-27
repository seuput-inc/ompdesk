/**
 * Installers (curl | bash, PowerShell, winget, brew) neither watch stdin nor die with the app. Each one therefore
 * runs under a supervisor: OMPdesk's own core binary in its `--supervise` mode (`native/ompdesk/crates/core/src/
 * supervise.rs`), started directly, with no running core needed. It starts the command with its whole tree held (a
 * process group of its own on POSIX, a job of its own on Windows), passes its output through, and ends that tree when
 * its stdin closes: a cancel (main ends stdin), an app quit, or a crash of the app that skips every quit handler. It
 * then exits `SUPERVISOR_STOPPED_CODE`, otherwise with the command's code, 127 when the command could not start. On
 * Windows the tree also ends with the supervisor, however it ends, except an isolated command's.
 *
 * The command comes from `OMPDESK_SETUP_SPEC` (`{file, args, shell, inputFile?, log?, isolated?}` JSON), never from
 * argv. `inputFile` becomes the child's stdin (else it gets none). `log` is the output file of an isolated command
 * (`SpawnSpec.isolated`, see `isolatedLaunch`): with `redirect` the supervisor hands it to the child as stdout/stderr;
 * either way its bytes become the supervisor's own output once the child exited.
 * The separate `{worktreeHook: ...}` form takes a hook kind, not an executable. Its stdout is a single bounded result.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import type { WorktreeSetupReport } from "../../shared/rpc-types";
import type { WorktreeHook } from "../local/git/worktree-seed";
import { nativeBinPath } from "../native-bin";
import { findOnPath } from "../spawn";
import { bunInstallDir } from "./paths";

/** One process a supervised run starts. */
export interface SpawnSpec {
	file: string;
	args: string[];
	/** Only for a Windows `.cmd` shim; args are then already quoted for cmd.exe. */
	shell: boolean;
	/** A file the supervisor hands the child as stdin (scheduled runs pipe their prompt this way). */
	inputFile?: string;
	/**
	 * The command may leave a descendant that outlives the app by design (ai-memory's `setup` starts ai-memory's own
	 * per-user service host): it gets no handle of the app's — no pipe, nothing the app inherited — only NUL as stdin
	 * and a temp file as stdout/stderr, which the supervisor passes on as its own output once the command exited.
	 * `file` is then an absolute path (or the `.cmd` shim `shell` runs) and `inputFile` is not used. On Windows it starts
	 * through Bun (`isolatedLaunch`), so it needs Bun installed.
	 */
	isolated?: boolean;
}

/** Where the command reaches the supervisor (`SPEC_ENV` in `supervise.rs`). */
const SUPERVISOR_SPEC_ENV = "OMPDESK_SETUP_SPEC";

/** Exit code the supervisor reports after it ended the command's tree for a stdin close (`STOPPED` in `supervise.rs`). */
export const SUPERVISOR_STOPPED_CODE = 130;

/**
 * Quote one argument for a Windows command line so the C runtime's parser (every `.exe` OMPdesk starts) reads it back
 * unchanged: libuv's rule for `child_process.spawn`.
 */
export function quoteWindowsArg(arg: string): string {
	if (arg === "") return '""';
	if (!/[\s"]/.test(arg)) return arg;
	let quoted = '"';
	let backslashes = 0;
	for (const char of arg) {
		if (char === "\\") {
			backslashes++;
			continue;
		}
		quoted += char === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${char}`;
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * Windows' isolated launch, run by Bun (`bun -e`, `bun:ffi` calling kernel32; no compiler, no PowerShell): it starts
 * the command with `CreateProcessW` and an explicit handle list (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so it inherits
 * NUL and the log file and nothing else, with no window (`CREATE_NO_WINDOW`) and the environment it was given, then
 * waits and exits with its code (127 when it could not start). A plain spawn cannot do this: libuv (Node's `spawn`) and
 * Rust's `Command` (the supervisor's) create every child with `bInheritHandles`, so it inherits every inheritable
 * handle of its parent, and Electron keeps its main process's stdio inheritable — a launcher's pipes (Playwright's, a
 * script's) reach the supervisor as stray handles no API names, and through it any command it starts. A descendant
 * that outlives the app (ai-memory's service host, started by `setup` with Rust's `Command`, also `bInheritHandles`)
 * would hold them, and the app's own pipes to the supervisor, open for as long as it runs. The command comes from
 * `OMPDESK_ISOLATED` (`{application, commandLine, log}` JSON), which the command's own environment leaves out.
 */
const ISOLATED_LAUNCHER = `
const { writeSync } = require("node:fs");
const { dlopen, FFIType: T, ptr } = require("bun:ffi");
const spec = JSON.parse(process.env.OMPDESK_ISOLATED);
const kernel32 = dlopen("kernel32.dll", {
	CreateFileW: { args: [T.ptr, T.u32, T.u32, T.ptr, T.u32, T.u32, T.ptr], returns: T.i64_fast },
	InitializeProcThreadAttributeList: { args: [T.ptr, T.u32, T.u32, T.ptr], returns: T.i32 },
	UpdateProcThreadAttribute: { args: [T.ptr, T.u32, T.u64, T.ptr, T.u64, T.ptr, T.ptr], returns: T.i32 },
	DeleteProcThreadAttributeList: { args: [T.ptr], returns: T.void },
	CreateProcessW: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.i32, T.u32, T.ptr, T.ptr, T.ptr, T.ptr], returns: T.i32 },
	WaitForSingleObject: { args: [T.i64, T.u32], returns: T.u32 },
	GetExitCodeProcess: { args: [T.i64, T.ptr], returns: T.i32 },
	CloseHandle: { args: [T.i64], returns: T.i32 },
	GetLastError: { args: [], returns: T.u32 },
}).symbols;
function fail(what) {
	writeSync(2, what + " failed (Windows error " + kernel32.GetLastError() + ")\\n");
	process.exit(127);
}
const wide = text => Buffer.from(text + "\\0", "utf16le");
// SECURITY_ATTRIBUTES { nLength, lpSecurityDescriptor, bInheritHandle = TRUE }
const inheritable = Buffer.alloc(24);
inheritable.writeUInt32LE(24, 0);
inheritable.writeUInt32LE(1, 16);
function open(name, access, disposition) {
	// Shared for reading, writing and deleting: the supervisor reads and removes the log while a descendant holds it.
	const path = wide(name);
	const handle = kernel32.CreateFileW(ptr(path), access, 7, ptr(inheritable), disposition, 0x80, null);
	if (handle === -1 || handle === -1n) fail("opening " + name);
	return BigInt(handle);
}
const input = open("NUL", 0x80000000, 3);
const output = open(spec.log, 0x40000000, 2);
const size = Buffer.alloc(8);
kernel32.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
const list = Buffer.alloc(Number(size.readBigUInt64LE(0)));
if (!kernel32.InitializeProcThreadAttributeList(ptr(list), 1, 0, ptr(size))) fail("InitializeProcThreadAttributeList");
const handles = Buffer.alloc(16);
handles.writeBigInt64LE(input, 0);
handles.writeBigInt64LE(output, 8);
// PROC_THREAD_ATTRIBUTE_HANDLE_LIST: of every inheritable handle, the command gets these two.
if (!kernel32.UpdateProcThreadAttribute(ptr(list), 0, 0x20002, ptr(handles), 16, null, null)) fail("UpdateProcThreadAttribute");
// STARTUPINFOEXW: cb, dwFlags = STARTF_USESTDHANDLES, hStdInput, hStdOutput, hStdError, lpAttributeList.
const startup = Buffer.alloc(112);
startup.writeUInt32LE(112, 0);
startup.writeUInt32LE(0x100, 60);
startup.writeBigInt64LE(input, 80);
startup.writeBigInt64LE(output, 88);
startup.writeBigInt64LE(output, 96);
startup.writeBigUInt64LE(BigInt(ptr(list)), 104);
// The command's environment: this one without the launch spec, as a sorted UTF-16 block.
const key = name => name.toUpperCase();
const environment = Buffer.from(
	Object.entries(process.env)
		.filter(([name, value]) => name !== "OMPDESK_ISOLATED" && value !== undefined)
		.sort(([a], [b]) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
		.map(([name, value]) => name + "=" + value + "\\0")
		.join("") + "\\0",
	"utf16le",
);
const application = wide(spec.application);
const commandLine = wide(spec.commandLine);
const information = Buffer.alloc(24);
// EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
const flags = 0x00080000 | 0x08000000 | 0x400;
if (!kernel32.CreateProcessW(ptr(application), ptr(commandLine), null, null, 1, flags, ptr(environment), null, ptr(startup), ptr(information))) {
	fail("starting " + spec.application);
}
kernel32.DeleteProcThreadAttributeList(ptr(list));
kernel32.CloseHandle(input);
kernel32.CloseHandle(output);
const child = information.readBigInt64LE(0);
kernel32.CloseHandle(information.readBigInt64LE(8));
kernel32.WaitForSingleObject(child, 0xffffffff);
const code = Buffer.alloc(4);
kernel32.GetExitCodeProcess(child, ptr(code));
kernel32.CloseHandle(child);
process.exit(code.readInt32LE(0));
`;

interface Launch {
	spec: SpawnSpec & { log?: { path: string; redirect: boolean } };
	env: NodeJS.ProcessEnv;
}

interface LaunchOptions {
	platform?: NodeJS.Platform;
	log?: string;
	/** Bun, which runs Windows' launcher; looked up on PATH, then in Bun's own install dir, when not given. */
	bun?: string | null;
}

/** Bun on `env`'s PATH (whatever its case on Windows), else in `BUN_INSTALL` or `%USERPROFILE%\.bun`. */
export function findBun(env: NodeJS.ProcessEnv): string | null {
	const pathEnv = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
	const installed = win32.join(bunInstallDir(env, env.USERPROFILE || homedir()), "bin", "bun.exe");
	return findOnPath(["bun.exe"], pathEnv, "win32", [installed]);
}

/** What the supervisor runs for an isolated `spec` (see `SpawnSpec.isolated`). */
export function isolatedLaunch(spec: SpawnSpec, env: NodeJS.ProcessEnv, options: LaunchOptions = {}): Launch {
	const log = options.log ?? join(tmpdir(), `ompdesk-isolated-${randomUUID()}.log`);
	// POSIX: the supervisor's spawn passes the child its stdio and nothing else (libuv closes every other descriptor on
	// exec), so the log file in place of the supervisor's pipes is all it takes.
	if ((options.platform ?? process.platform) !== "win32") {
		return { spec: { ...spec, log: { path: log, redirect: true } }, env };
	}
	const bun = options.bun === undefined ? findBun(env) : options.bun;
	if (!bun)
		throw new Error("Bun was not found: on Windows OMPdesk starts this command through it (setup installs Bun)");
	const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
	// A `.cmd` shim runs the way Node's `shell: true` runs it: `file` and `args` are already quoted for cmd.exe.
	const [application, commandLine] = spec.shell
		? [win32.join(systemRoot, "System32", "cmd.exe"), `cmd.exe /d /s /c "${[spec.file, ...spec.args].join(" ")}"`]
		: [spec.file, [spec.file, ...spec.args].map(quoteWindowsArg).join(" ")];
	return {
		spec: {
			file: bun,
			args: ["-e", ISOLATED_LAUNCHER],
			shell: false,
			isolated: true,
			log: { path: log, redirect: false },
		},
		env: { ...env, OMPDESK_ISOLATED: JSON.stringify({ application, commandLine, log }) },
	};
}

/** Start `spec` under the supervisor with `env` (in `cwd`, else main's); stdin stays open until a cancel. */
export function spawnSupervised(spec: SpawnSpec, env: NodeJS.ProcessEnv, cwd?: string): ChildProcess {
	const launch = spec.isolated ? isolatedLaunch(spec, env) : { spec, env };
	return startSupervisor(launch.spec, launch.env, cwd);
}

interface HookSpec {
	kind: WorktreeHook;
	primary: string;
	worktree: string;
	fromPrimary: boolean;
	logDir: string;
	deadlineMs: number;
}

function startSupervisor(spec: Launch["spec"] | { worktreeHook: HookSpec }, env: NodeJS.ProcessEnv, cwd?: string) {
	return spawn(nativeBinPath("ompdesk-core"), ["--supervise"], {
		env: { ...env, [SUPERVISOR_SPEC_ENV]: JSON.stringify(spec) },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		...(cwd ? { cwd } : {}),
	});
}

/** Only the hook supervisor writes this packet: one timeout byte, then at most 4096 UTF-16LE units. */
export async function superviseWorktreeHook(
	kind: HookSpec["kind"],
	where: { primary: string; worktree: string; cwd: string; timeoutMs: number },
	found: { script: string; logPath: string },
	signal?: AbortSignal,
): Promise<WorktreeSetupReport> {
	signal?.throwIfAborted();
	const { primary, worktree, cwd, timeoutMs } = where;
	const root = dirname(dirname(found.script));
	const script = relative(root, found.script);
	const { logPath } = found;
	const started = Date.now();
	const spec = {
		kind,
		primary,
		worktree,
		fromPrimary: relative(root, primary) === "",
		logDir: dirname(logPath),
		deadlineMs: started + (timeoutMs >= 1 && timeoutMs <= 2_147_483_647 ? Math.trunc(timeoutMs) : 1),
	};
	const env = kind === "setup" ? { ...process.env, OMPDESK_SETUP_CLI: nativeBinPath("ompdesk") } : process.env;
	const child = startSupervisor({ worktreeHook: spec }, env, cwd);
	const stop = () => child.stdin.end();
	signal?.addEventListener("abort", stop, { once: true });
	const chunks: Buffer[] = [];
	let bytes = 0;
	child.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		if (bytes <= 8193) chunks.push(chunk);
	});
	let diagnostic = "";
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		diagnostic = (diagnostic + chunk).slice(-4096);
	});
	let spawnFailed = false;
	child.once("error", error => {
		spawnFailed = true;
		diagnostic = `${error.message}\n`;
	});
	// 'close', including after a spawn error, means both the process and its pipes have ended.
	const closed = Promise.withResolvers<number | null>();
	child.once("close", closed.resolve);
	const code = await closed.promise;
	signal?.removeEventListener("abort", stop);
	const packet = Buffer.concat(chunks);
	const valid = bytes <= 8193 && bytes % 2 === 1 && (packet[0] === 0 || packet[0] === 1);
	const timedOut = valid && packet[0] === 1;
	const exitCode = valid && !timedOut && code !== SUPERVISOR_STOPPED_CODE ? code : null;
	const outputTail = valid
		? packet.toString("utf16le", 1)
		: diagnostic || "Worktree hook supervisor returned no result.\n";
	// A repo controls this directory: stage with exclusive creation, even if the supervisor failed to start.
	if (spawnFailed && !signal?.aborted) {
		const stage = `${logPath}.${randomUUID()}.tmp`;
		const file = await fs.open(stage, "wx", 0o600).catch(() => null);
		if (file) {
			try {
				try {
					await file.writeFile(outputTail);
				} finally {
					await file.close();
				}
				if (signal?.aborted) await fs.unlink(stage);
				else await fs.rename(stage, logPath);
			} catch {
				await fs.unlink(stage).catch(() => undefined);
			}
		}
	}
	return {
		script,
		ok: exitCode === 0,
		exitCode,
		timedOut,
		durationMs: Date.now() - started,
		logPath,
		outputTail: valid ? outputTail : outputTail.slice(-4096),
	};
}
