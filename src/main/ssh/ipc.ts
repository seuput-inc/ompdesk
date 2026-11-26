import { app, BrowserWindow } from "electron";
import {
	SSH_TOOLS_AGENT,
	SSH_TOOLS_COMMAND,
	SSH_TOOLS_PROMPT,
	SSH_TOOLS_PROMPTS,
	SSH_TOOLS_STATE,
} from "../../shared/ssh-tools";
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
export function registerSshToolsIpc(ipc: IpcRegistry): void {
	const tools = new SshTools({
		userData: app.getPath("userData"),
		broadcast: (kind, data) => {
			for (const win of BrowserWindow.getAllWindows())
				if (!win.isDestroyed()) win.webContents.send(kind === "state" ? SSH_TOOLS_STATE : SSH_TOOLS_PROMPT, data);
		},
	});
	shared = tools;
	ipc.handle(SSH_TOOLS_COMMAND, (_caller, request: unknown) => tools.command(request));
	ipc.handle(SSH_TOOLS_AGENT, () => tools.agent());
	// A window that opens (or reloads) while a question waits still sees it.
	ipc.handle(SSH_TOOLS_PROMPTS, () => tools.prompts());
	app.on("will-quit", () => tools.dispose());
	void tools.start().catch(error => console.warn("Could not restore SSH forwards:", error));
}
