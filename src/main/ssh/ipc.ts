import { app, BrowserWindow } from "electron";
import { SSH_TOOLS_PROMPT, SSH_TOOLS_STATE } from "../../shared/ssh-tools";
import { CorePort } from "../core/ports";
import { core } from "../core/process";
import type { IpcRegistry } from "../web/ipc-registry";
import { SshTools } from "./service";

let shared: SshTools | null = null;

/** The computer woke, was unlocked or came back online: dropped forwards and watches go again now (`SshTools.wake`). */
export function wakeSshTools(): void {
	shared?.wake();
}

/** What a Terminal panel PTY runs to reach a saved host; refused before Settings › SSH tools started. */
export function sshTerminalCommand(target: unknown): Promise<{ bin: string; args: string[] }> {
	if (!shared) throw new Error("SSH tools are not running");
	return shared.terminal(target);
}

/** Settings › SSH tools for every window; saved forwards start again right away (C151 restore). */
export function registerSshToolsIpc(_ipc: IpcRegistry): void {
	const tools = new SshTools({
		userData: app.getPath("userData"),
		broadcast: (kind, data) => {
			for (const win of BrowserWindow.getAllWindows())
				if (!win.isDestroyed()) win.webContents.send(kind === "state" ? SSH_TOOLS_STATE : SSH_TOOLS_PROMPT, data);
		},
	});
	shared = tools;
	// `ssh-tools:command`, `ssh-tools:agent` and `ssh-tools:prompts` route directly from tauri-shell to ompdesk-core
	// (`crates/core/src/ssh/mod.rs`).
	const port = new CorePort({
		command: ({ request, hasRequest }: { request?: unknown; hasRequest?: boolean }) =>
			tools.command(hasRequest ? request : undefined),
		agent: () => tools.agent(),
	});
	const connect = () => {
		void core()
			.call("ssh.toolsPort", { port: port.id })
			.catch(() => {});
	};
	connect();
	core().on("ready", connect);
	app.on("will-quit", () => {
		port.close();
		tools.dispose();
	});
	void tools.start().catch(error => console.warn("Could not restore SSH forwards:", error));
}
