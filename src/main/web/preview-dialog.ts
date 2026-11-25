/**
 * JS dialogs of a viewer's offscreen page. The page's own `alert`, `confirm` and `prompt` open in the Preview
 * browser, which reports each as CDP's `Page.javascriptDialogOpening` and keeps the page blocked until
 * `Page.handleJavaScriptDialog`. The shell's Preview owner (`tauri-shell/src/preview/dialogs.rs`) turns that into
 * one `ipc.sendSync` request on `DIALOG_CHANNEL`, which is answered here when the viewer answers on its phone
 * (`PageStream.openDialog`), however much later, and answers the dialog with it. Nothing is injected into the page and
 * no debugger is attached, so the `choose` gate (C143) stays as it is.
 *
 * `beforeunload` is never sent: the shell lets the page go. Main answers the channel only for a page it streams;
 * any other page, an invalid request, a request the shell withdraws (the dialog ended meanwhile) and a stream that
 * ends all dismiss the dialog, so a page is never left blocked on a viewer that is not there.
 */
import { z } from "zod";
import type { DialogAnswer, DialogRequest } from "./preview-stream";

/** The channel the shell asks on (`ipcMain.on`, never the web registry: a page is no caller). */
export const DIALOG_CHANNEL = "preview-web:dialog";

const MESSAGE_MAX = 2000;

export const dialogRequestSchema: z.ZodType<DialogRequest> = z.object({
	kind: z.enum(["alert", "confirm", "prompt"]),
	message: z.string().max(MESSAGE_MAX),
	initial: z.string().max(MESSAGE_MAX).nullable(),
});

/** What the shell hands the page's function: null for `alert`, a boolean for `confirm`, a string or null for `prompt`. */
export function dialogReturnValue(
	request: DialogRequest,
	answer: { accept: boolean; text: string | null },
): boolean | string | null {
	if (request.kind === "alert") return null;
	if (request.kind === "confirm") return answer.accept;
	return answer.accept ? (answer.text ?? request.initial ?? "") : null;
}

/** The slice of the shim's `ipc.sendSync` event the channel uses. */
export interface DialogChannelEvent {
	sender: { id: number };
	/** The first value set answers the shell; it may be set long after the handler returned. */
	returnValue?: unknown;
	/** Aborts when the shell stops waiting (the dialog ended or the page went). */
	signal?: AbortSignal;
}

/** The slice of a `PageStream` the channel uses. */
export interface DialogStream {
	openDialog(request: DialogRequest, signal?: AbortSignal): Promise<DialogAnswer>;
}

/** The `ipcMain.on(DIALOG_CHANNEL)` listener over the streamed pages by their `webContents.id`. */
export function dialogChannel(
	streams: ReadonlyMap<number, DialogStream>,
): (event: DialogChannelEvent, raw: unknown) => void {
	return (event, raw) => {
		const request = dialogRequestSchema.safeParse(raw);
		const stream = streams.get(event.sender.id);
		if (!request.success || !stream) {
			event.returnValue = null;
			return;
		}
		void stream.openDialog(request.data, event.signal).then(answer => {
			event.returnValue = dialogReturnValue(request.data, answer);
		});
	};
}
