/**
 * macOS asks "OMPdesk would like to access files in your Documents folder" whenever a session's omp (or a tool it
 * runs) reads a protected folder, because TCC names OMPdesk as the responsible app; a person who works in those folders
 * sees the dialog again and again. The system log says when such a dialog is shown, so the first one attributed to
 * OMPdesk gets one OS notice that opens Full Disk Access (Orca M87; approach after Orca, MIT, stablyai/orca
 * `src/main/macos-permissions/macos-tcc-prompt-watch.ts`, re-implemented).
 *
 * `log stream` ignores its parent's death, so it runs under a small shell that ends it when its stdin closes: the app
 * quitting or crashing ends the watch (AGENTS.md › Dev rules). A watch that ends by itself is started again once.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** The app's bundle id: the one TCC names as responsible for what OMPdesk and its children read. */
const BUNDLE_ID = "com.seuput.ompdesk";

/** The folder services Full Disk Access covers. */
const FOLDER_SERVICES: Record<string, true> = {
	kTCCServiceSystemPolicyAppData: true,
	kTCCServiceSystemPolicyAllFiles: true,
	kTCCServiceSystemPolicyDocumentsFolder: true,
	kTCCServiceSystemPolicyDesktopFolder: true,
	kTCCServiceSystemPolicyDownloadsFolder: true,
	kTCCServiceSystemPolicyRemovableVolumes: true,
	kTCCServiceSystemPolicyNetworkVolumes: true,
};

const PREDICATE = 'subsystem == "com.apple.TCC" AND eventMessage CONTAINS "AUTHREQ_PROMPTING"';

/** Ends `log stream` when this script's stdin closes; the stdin is kept on fd 3 because `&` hands /dev/null. */
const WRAPPER = `set +eu
exec 3<&0
/usr/bin/log stream --predicate "$1" --info --style compact </dev/null 3<&- &
pid=$!
{ read -r _ <&3; kill "$pid" 2>/dev/null; } &
wait "$pid"`;

export const FULL_DISK_ACCESS_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export interface TccPrompt {
	service: string;
	responsible: string;
}

/** A `log stream --style compact` line of a TCC dialog being shown, else null. */
export function parseTccPrompt(line: string): TccPrompt | null {
	if (!line.includes("AUTHREQ_PROMPTING")) return null;
	const service = /\bservice=(kTCCService\w+)/.exec(line)?.[1];
	const responsible = /\bResp:\{TCCDProcess:\s*identifier=([^,}]+)/.exec(line)?.[1]?.trim();
	return service && responsible ? { service, responsible } : null;
}

/** A folder dialog macOS shows on OMPdesk's account. */
export function isOmpdeskFolderPrompt(prompt: TccPrompt): boolean {
	return prompt.responsible === BUNDLE_ID && Object.hasOwn(FOLDER_SERVICES, prompt.service);
}

type LogStream = ChildProcessByStdio<Writable, Readable, null>;

/** Watches for OMPdesk's folder dialogs; `onPrompt` hears each one. Nothing off macOS. */
export function watchTccPrompts(
	onPrompt: (prompt: TccPrompt) => void,
	start: () => LogStream = () =>
		spawn("/bin/sh", ["-c", WRAPPER, "sh", PREDICATE], { stdio: ["pipe", "pipe", "ignore"] }),
): () => void {
	let child: LogStream | null = null;
	let restarted = false;
	let stopped = false;
	const run = () => {
		let started: LogStream;
		try {
			started = start();
		} catch {
			return;
		}
		child = started;
		createInterface({ input: started.stdout }).on("line", line => {
			const prompt = parseTccPrompt(line);
			if (prompt && isOmpdeskFolderPrompt(prompt)) onPrompt(prompt);
		});
		const ended = () => {
			if (child !== started) return;
			child = null;
			started.stdin.destroy();
			if (stopped || restarted) return;
			restarted = true;
			setTimeout(run, 1_000).unref();
		};
		started.once("error", ended);
		started.once("exit", ended);
	};
	run();
	return () => {
		stopped = true;
		child?.stdin.destroy();
		child?.kill();
		child = null;
	};
}

/** Set once the folder-access notice was shown: it is shown once ever. */
export const FOLDER_ACCESS_NOTICE_PREF = "folderAccessNoticeShown";
