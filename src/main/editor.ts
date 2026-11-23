/** The host launches the user's GUI editor outside the core's kill-on-exit process tree. */

import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { codedError } from "../shared/ipc-error-codes";
import { core } from "./core/process";
import { resolveEditorCommand, spawnPath } from "./shell-env";

export interface EditorRoundTripResult {
	/** Edited text (exit 0), null when the editor exits non-zero (draft unchanged). */
	text: string | null;
}

interface PreparedDraft {
	id: { folder: string; token: string };
	file: string;
}

export async function openInExternalEditor(content: string): Promise<EditorRoundTripResult> {
	// Resolution order: process $VISUAL/$EDITOR → login-shell $VISUAL/$EDITOR →
	// notepad (win32). The shell probe covers Finder-launched apps, whose rc-file
	// editor settings never reach the GUI process env.
	const editorCmd = await resolveEditorCommand();
	if (!editorCmd) {
		throw codedError("editor_unset", "Set $VISUAL or $EDITOR to use an external editor");
	}
	const client = core();
	const env = { ...process.env, PATH: await spawnPath() };
	const { result: draft } = await client.call<PreparedDraft>("editor.prepare", {}, { bin: Buffer.from(content) });
	let read = false;
	try {
		const [editor, ...args] = editorCmd.split(" ");
		// cmd expands the quoted variable once. The generated filename is never part of the configured command.
		const windows = process.platform === "win32";
		if (windows && /["\r\n]/.test(draft.file)) throw new Error("Invalid Windows editor draft path");
		const child = windows
			? spawn(
					process.env.ComSpec || "cmd.exe",
					["/d", "/v:off", "/s", "/c", `"${editorCmd} "%OMPDESK_EDITOR_DRAFT%""`],
					{
						stdio: "ignore",
						windowsHide: true,
						windowsVerbatimArguments: true,
						env: { ...env, OMPDESK_EDITOR_DRAFT: draft.file },
					},
				)
			: spawn(editor, [...args, draft.file], { stdio: "ignore", env });
		const { promise, reject, resolve } = Promise.withResolvers<number>();
		child.once("exit", (code, signal) => resolve(code ?? (signal ? -1 : 0)));
		child.once("error", error => reject(error));
		read = (await promise) === 0;
	} finally {
		if (!read) await client.call("editor.finish", { id: draft.id, read: false }).catch(() => {});
	}
	if (!read) return { text: null };
	const { bin } = await client.call("editor.finish", { id: draft.id, read: true });
	if (!bin) throw new Error("Missing external-editor draft");
	return { text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bin) };
}
