import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readlink } from "node:fs/promises";
import type { TerminalCheckpoint, TerminalOperation, TerminalRead } from "../../../src/shared/terminal-types";
import { ompModuleFile } from "../omp-package";
import type { HelperMethods } from "./dispatch";
import { type Pty, type PtyOptions, TerminalService } from "./terminal-service";

let service: TerminalService | null = null;
let starting: Promise<TerminalService> | null = null;
/**
 * Main's `userData`, said with each checkpoint pass and restore (`main/terminal/history.ts`): a closed terminal's
 * saved history goes with it. Unknown until then, when none of this worker's terminals has a file yet.
 */
let userData: string | undefined;
/** One service for the worker: overlapping first requests (two panes restoring at launch) share its creation,
 * so no PTY lands in a second service that `terminal.dispose`/`disposeTerminals()` never reach. */
function terminals(): Promise<TerminalService> {
	if (service) return Promise.resolve(service);
	starting ??= (async () => {
		// Reuse stock's portable-pty / Windows ConPTY implementation in Bun. No Electron native addon.
		const stock = await import(ompModuleFile("pi-natives"));
		if (typeof stock.PtySession !== "function") throw new Error("Installed omp has no interactive PtySession");
		service = new TerminalService(() => new stock.PtySession() as Pty, shellCwd, commandRunning);
		return service;
	})().catch(error => {
		starting = null;
		throw error;
	});
	return starting;
}
export function disposeTerminals(): void {
	service?.dispose();
}

/**
 * Whether a command runs in the shell `pid` (Orca probes the PTY's child processes for its close guard). POSIX: the
 * terminal's foreground process group is another than the shell's own (a job runs; a prompt's background helper such
 * as gitstatusd does not count). Windows: the shell has a child process. Null when neither can be read in time.
 */
function commandRunning(pid: number): Promise<boolean | null> {
	const { promise, resolve } = Promise.withResolvers<boolean | null>();
	const windows = process.platform === "win32";
	const [command, args] = windows
		? [
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}').Count`,
				],
			]
		: ["ps", ["-o", "tpgid=", "-o", "pgid=", "-p", String(pid)]];
	execFile(command, args, { timeout: 4000, windowsHide: true }, (error, stdout) => {
		const numbers = error ? [] : stdout.trim().split(/\s+/).map(Number);
		if (windows) resolve(Number.isInteger(numbers[0]) ? (numbers[0] ?? 0) > 0 : null);
		else if (numbers.length === 2 && numbers.every(Number.isInteger))
			resolve((numbers[0] ?? 0) > 0 && numbers[0] !== numbers[1]);
		else resolve(null);
	});
	return promise;
}

/** The folder a shell is in now: Linux's `/proc`, macOS's `lsof`; Windows has no such read, so the start folder stands. */
async function shellCwd(pid: number): Promise<string | null> {
	if (process.platform === "linux") {
		const cwd = await readlink(`/proc/${pid}/cwd`);
		// A removed folder reads back as `<path> (deleted)`, which no shell can return to.
		return cwd.endsWith(" (deleted)") ? null : cwd;
	}
	if (process.platform !== "darwin") return null;
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(
		"lsof",
		["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
		{ timeout: 2000, windowsHide: true },
		(error, stdout) => {
			const line = error ? undefined : stdout.split("\n").find(item => item.startsWith("n"));
			resolve(line ? line.slice(1) : null);
		},
	);
	return promise;
}

type ShellChoice = { path: string; args: string[] };
/** How a terminal starts: `extra` (main's per-terminal variables) over this worker's environment, `shell` or the login shell. */
function ptyOptions(
	cwd: string,
	extra: Record<string, string> | undefined,
	shell: ShellChoice | undefined,
): PtyOptions {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, extra);
	env.TERM = "xterm-256color";
	env.TERM_PROGRAM = "OMPdesk";
	const windows = process.platform === "win32";
	const application = shell?.path ?? (windows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/zsh");
	return { application, args: shell?.args ?? (windows ? [] : ["-l"]), cwd, env, cols: 80, rows: 24 };
}

export const methods: HelperMethods = {
	"terminal.request": async (params, frame) => {
		const { owner, cwd, operation, shell, env, read, session } = params as {
			owner: string;
			read?: TerminalRead;
			cwd: string;
			operation: TerminalOperation;
			/** Main's per-terminal variables over this worker's own (the control socket's, or that it is off). */
			env?: Record<string, string>;
			/** A shell main detected (main/terminal/shells.ts); absent = the login shell. */
			shell?: ShellChoice;
			/** The tab's session file ("" for none), which keeps its terminals across a restart. */
			session?: string;
		};
		const options = ptyOptions(cwd, env, shell);
		const service = await terminals();
		// A web viewer's long poll holds here, in the worker, until the PTY writes (never a timer loop in main).
		if (operation.action === "list" && operation.waitMs) await service.wait(owner, operation);
		const busy = operation.action === "busy" ? await service.busy(owner, operation.id) : null;
		const answer = terminalFrame(service, owner, operation, options, read, session);
		if (operation.action === "busy" && busy !== null)
			answer.rows = answer.rows.map(row => (row.id === operation.id ? { ...row, busy } : row));
		return frame(answer);
	},
	/** A tab's saved terminals back after a restart (`main/terminal/history.ts`), each in its folder when it still exists. */
	"terminal.restore": async params => {
		const {
			owner,
			cwd,
			env,
			session,
			notice,
			terminals: saved,
			...said
		} = params as {
			owner: string;
			cwd: string;
			env?: Record<string, string>;
			session: string;
			notice: string;
			userData: string;
			terminals: Array<Omit<TerminalCheckpoint, "shell" | "session"> & { shell?: ShellChoice }>;
		};
		userData = said.userData;
		const restored = saved.map(({ shell, ...terminal }) => ({
			...terminal,
			options: ptyOptions(existsSync(terminal.cwd) ? terminal.cwd : cwd, env, shell),
		}));
		(await terminals()).restore(owner, session, restored, notice);
		return null;
	},
	/**
	 * The terminals that changed (`all`: every one), held up to `waitMs` for a change: the core's scrollback writes
	 * each one's history file as it reads this frame.
	 */
	"terminal.checkpoints": async (params, frame) => {
		const { all, waitMs, ...said } = params as { all?: boolean; waitMs?: number; userData: string };
		userData = said.userData;
		if (!service) return [];
		const { rows, save } = await service.checkpoints({ all, waitMs });
		return frame({ rows, history: { userData, save } });
	},
	/** One command (not the login shell) in a PTY, e.g. `gh auth login`, which needs a TTY. Main supplies the whole env. */
	"pty.request": async (params, frame) => {
		const { owner, application, args, cwd, env, operation } = params as {
			owner: string;
			application: string;
			args: string[];
			cwd: string;
			env: Record<string, string>;
			operation: TerminalOperation;
		};
		const service = await terminals();
		return frame(terminalFrame(service, owner, operation, { application, args, cwd, env, cols: 120, rows: 30 }));
	},
	"terminal.dispose": async (params, frame) => {
		const { owner } = params as { owner: string };
		// Join the same startup as an earlier create, or a close during the first import leaves that PTY running.
		if (starting) {
			try {
				await starting;
			} catch {
				return frame({});
			}
		}
		const forget = service?.dispose(owner);
		return frame({ forget, history: forget?.length && userData ? { userData, drop: forget } : undefined });
	},
};

function terminalFrame(
	service: TerminalService,
	owner: string,
	operation: TerminalOperation,
	options: PtyOptions,
	read?: TerminalRead,
	session?: string,
) {
	return {
		read,
		rows: service.request(owner, operation, options, session),
		forget: operation.action === "clear" || operation.action === "close" ? [operation.id] : undefined,
		// A closed terminal's saved history goes with it (scrollback can hold secrets).
		history: operation.action === "close" && userData ? { userData, drop: [operation.id] } : undefined,
		budget: operation.action === "list" ? operation.budget : undefined,
	};
}
