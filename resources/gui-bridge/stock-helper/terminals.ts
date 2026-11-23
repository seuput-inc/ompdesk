import type { TerminalOperation, TerminalRead } from "../../../src/shared/terminal-types";
import { ompModuleFile } from "../omp-package";
import type { HelperMethods } from "./dispatch";
import { type Pty, type PtyOptions, TerminalService } from "./terminal-service";

let service: TerminalService | null = null;
let starting: Promise<TerminalService> | null = null;
/** One service for the worker: overlapping first requests (two panes restoring at launch) share its creation,
 * so no PTY lands in a second service that `terminal.dispose`/`disposeTerminals()` never reach. */
function terminals(): Promise<TerminalService> {
	if (service) return Promise.resolve(service);
	starting ??= (async () => {
		// Reuse stock's portable-pty / Windows ConPTY implementation in Bun. No Electron native addon.
		const stock = await import(ompModuleFile("pi-natives"));
		if (typeof stock.PtySession !== "function") throw new Error("Installed omp has no interactive PtySession");
		service = new TerminalService(() => new stock.PtySession() as Pty);
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
export const methods: HelperMethods = {
	"terminal.request": async (params, frame) => {
		const {
			owner,
			cwd,
			operation,
			shell,
			env: extra,
			read,
		} = params as {
			owner: string;
			read?: TerminalRead;
			cwd: string;
			operation: TerminalOperation;
			/** Main's per-terminal variables over this worker's own (the control socket's, or that it is off). */
			env?: Record<string, string>;
			/** A shell main detected (main/terminal/shells.ts); absent = the login shell. */
			shell?: { path: string; args: string[] };
		};
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		Object.assign(env, extra);
		env.TERM = "xterm-256color";
		env.TERM_PROGRAM = "OMPdesk";
		const windows = process.platform === "win32";
		const application = shell?.path ?? (windows ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/zsh");
		const options = {
			application,
			args: shell?.args ?? (windows ? [] : ["-l"]),
			cwd,
			env,
			cols: 80,
			rows: 24,
		};
		const service = await terminals();
		// A web viewer's long poll holds here, in the worker, until the PTY writes (never a timer loop in main).
		if (operation.action === "list" && operation.waitMs) await service.wait(owner, operation);
		return frame(terminalFrame(service, owner, operation, options, read));
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
		return frame({ forget: service?.dispose(owner) });
	},
};

function terminalFrame(
	service: TerminalService,
	owner: string,
	operation: TerminalOperation,
	options: PtyOptions,
	read?: TerminalRead,
) {
	return {
		read,
		rows: service.request(owner, operation, options),
		forget: operation.action === "clear" || operation.action === "close" ? [operation.id] : undefined,
		budget: operation.action === "list" ? operation.budget : undefined,
	};
}
