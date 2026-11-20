import type { RenderProcessGoneDetails } from "electron";

export const RENDERER_RECOVERY_COOLDOWN_MS = 30_000;

export interface ApplicationResourceIdentity {
	device: number;
	inode: number;
	size: number;
	modifiedAt: number;
}

/**
 * A packaged app must never reload renderer files that an update replaced after
 * launch: the new `index.html` names asset chunks the page this run loaded does not
 * have, and a reload would serve one of them as the page itself.
 */
export function applicationResourcesChanged(
	launchIdentity: ApplicationResourceIdentity | null,
	currentIdentity: ApplicationResourceIdentity | null,
): boolean {
	if (launchIdentity === null) return false;
	if (currentIdentity === null) return true;
	return (
		launchIdentity.device !== currentIdentity.device ||
		launchIdentity.inode !== currentIdentity.inode ||
		launchIdentity.size !== currentIdentity.size ||
		launchIdentity.modifiedAt !== currentIdentity.modifiedAt
	);
}

/** Reload real crashes, but never turn a boot crash into a tight reload loop. */
export function shouldReloadRenderer(
	reason: RenderProcessGoneDetails["reason"],
	lastRecoveryAt: number,
	now: number,
): boolean {
	return reason !== "clean-exit" && now - lastRecoveryAt >= RENDERER_RECOVERY_COOLDOWN_MS;
}

/**
 * A window whose page stopped answering (the shell's `unresponsive`: its probe went unanswered 20 s) is given this long
 * to answer again before its page process is ended and the page loads again (19 Nov 2026: the Mac mini's page sat in a
 * WebKit log-stream wait for hours, and nothing the window showed or did changed).
 */
export const RENDERER_HANG_RESTART_MS = 15_000;
/** A second restart of a stuck page within this long tells the person once; a single one only goes to the log. */
export const RENDERER_HANG_NOTICE_WITHIN_MS = 60 * 60_000;

/** Whether this restart of a stuck page is told to the person: it repeats one within the hour. */
export function hangRestartNotifies(lastRestartAt: number | null, now: number): boolean {
	return lastRestartAt !== null && now - lastRestartAt < RENDERER_HANG_NOTICE_WITHIN_MS;
}

/**
 * Which renderer failures justify replacing the whole process when the packaged
 * resources were swapped underneath it. A console error or an in-place main-frame
 * navigation is routine — both used to relaunch the app and kill every running
 * agent; only a load failure or a dead process means the shell is unrecoverable.
 */
export type RendererFailure =
	| { kind: "console-error" }
	| { kind: "main-frame-navigation" }
	| { kind: "load-failure"; mainFrame: boolean }
	| { kind: "process-gone"; reloadable: boolean };

export function shouldRestartForChangedResources(failure: RendererFailure): boolean {
	switch (failure.kind) {
		case "load-failure":
			return failure.mainFrame;
		case "process-gone":
			return failure.reloadable;
		default:
			return false;
	}
}
