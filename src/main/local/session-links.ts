/**
 * Links a person or an agent attached to a session (Orca's workspace references, `src/cli/references/reference.ts`,
 * MIT). The store and its rules are the core's (`crates/core/src/prefs/session_links.rs`, `<userData>/session-links.json`:
 * how many per session and how many sessions keep them), and a deleted session's links go with its tombstone there
 * (`sessions/deleted.rs`). Main reads the command: its shape, and the URL with the parser the page shares
 * (`sessionLink`), and tells every window and phone page here of a change. A window's or phone page's command
 * (`SESSIONS_LINKS`) is answered by the computer that runs the session: `ipc.ts` here, a paired host's `sessions.links`
 * there; an agent's reaches that computer through its tab.
 */
import { z } from "zod";
import { type SessionLinksCommand, sessionLink } from "../../shared/session-links";
import { type PrefsStore, prefsFile } from "../prefs-store";
import { LocalCommandError, type LocalHandler } from "./types";

const LinkText = z.string().min(1).max(4096);
/** A window's, phone page's or paired device's command (`SESSIONS_LINKS`, `sessions.links`). */
export const SessionLinksParams = z
	.object({
		command: z.discriminatedUnion("type", [
			z.object({ type: z.literal("session_links"), sessionPath: LinkText.optional() }).strict(),
			z
				.object({
					type: z.enum(["session_link_add", "session_link_remove"]),
					sessionPath: LinkText,
					url: LinkText,
				})
				.strict(),
		]),
	})
	.strict() satisfies z.ZodType<{ command: SessionLinksCommand }>;

let file: PrefsStore | null = null;
const store = (): PrefsStore => (file ??= prefsFile("session-links"));

let changed: () => void = () => {};

/** `ipc.ts`: every window and phone page here reads the links again. */
export function onSessionLinksChanged(listener: () => void): void {
	changed = listener;
}

function sessionOf(command: { sessionPath?: unknown }, sessionFile: string | undefined): string {
	const path = command.sessionPath ?? sessionFile;
	if (typeof path !== "string" || path.length === 0 || path.length > 4096)
		throw new LocalCommandError("This session has no saved file yet, so it cannot keep links.", "no_session");
	return path;
}

function urlOf(command: { url?: unknown }): string {
	if (typeof command.url !== "string" || command.url.length > 4096)
		throw new LocalCommandError("Give the link as a URL.", "invalid_link");
	return command.url;
}

/**
 * One session-link command. `sessionFile`: the asking tab's session, the target when the command names none; a
 * window's command has none (`undefined`), and its `session_links` without a path lists every session, as one with
 * `all` does.
 */
export function answerSessionLinks(
	command: { type: string; sessionPath?: unknown; url?: unknown; all?: unknown },
	sessionFile: string | undefined,
): unknown {
	switch (command.type) {
		case "session_links":
			return command.all === true || (command.sessionPath === undefined && sessionFile === undefined)
				? store().sessionLinks()
				: store().sessionLinks(sessionOf(command, sessionFile));
		case "session_link_add": {
			const sessionPath = sessionOf(command, sessionFile);
			const url = urlOf(command);
			const link = sessionLink(url);
			if (!link)
				throw new LocalCommandError(
					`Not a link a session keeps: "${url.slice(0, 200)}". Give an https URL (a pull request, an issue or any page).`,
					"invalid_link",
				);
			const added = store().addSessionLink(sessionPath, link);
			changed();
			return added;
		}
		case "session_link_remove": {
			const sessionPath = sessionOf(command, sessionFile);
			const url = urlOf(command);
			// The URL as given or as `sessionLink` writes it.
			const left = store().removeSessionLink(sessionPath, sessionLink(url)?.url ?? url.trim());
			changed();
			return left;
		}
		default:
			throw new LocalCommandError(`Unknown session link command ${command.type}`, "unknown_command");
	}
}

// A tab's command without a path is its own session's, saved or not.
const handle: LocalHandler = async (command, ctx) => answerSessionLinks(command, ctx.sessionFile ?? "");

export const handlers: Record<string, LocalHandler> = {
	session_links: handle,
	session_link_add: handle,
	session_link_remove: handle,
};
