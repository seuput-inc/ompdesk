/**
 * Links a person or an agent attached to a session (Orca's workspace references, `src/cli/references/reference.ts`,
 * MIT): kept per session file in `<userData>/session-links.json`, at most `SESSION_LINKS_MAX` per session and
 * `SESSION_LINK_SESSIONS_MAX` sessions (the least recently changed go first). A window's or phone page's command
 * (`SESSIONS_LINKS`) is answered by the computer that runs the session: `ipc.ts` here, a paired host's `sessions.links`
 * there; an agent's reaches that computer through its tab.
 */
import { z } from "zod";
import {
	SESSION_LINK_SESSIONS_MAX,
	SESSION_LINKS_MAX,
	type SessionLink,
	type SessionLinksCommand,
	sessionLink,
} from "../../shared/session-links";
import { type PrefsStore, prefsFile } from "../prefs-store";
import { LocalCommandError, type LocalHandler } from "./types";

type Links = Record<string, SessionLink[]>;

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

let file: PrefsStore<Links> | null = null;
const store = (): PrefsStore<Links> => (file ??= prefsFile<Links>("session-links"));

let changed: () => void = () => {};

/** `ipc.ts`: every window and phone page here reads the links again. */
export function onSessionLinksChanged(listener: () => void): void {
	changed = listener;
}

function save(next: Links): void {
	store().store = next;
	changed();
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

/** The links of every session, or of one. */
export function sessionLinks(sessionPath?: string): Links {
	const all = store().store;
	if (sessionPath === undefined) return all;
	return all[sessionPath] ? { [sessionPath]: all[sessionPath] } : {};
}

/** Adds (or moves to the newest place) one link; a URL `sessionLink` refuses is refused with the reason. */
export function addSessionLink(sessionPath: string, url: string): SessionLink {
	const link = sessionLink(url);
	if (!link)
		throw new LocalCommandError(
			`Not a link a session keeps: "${url.slice(0, 200)}". Give an https URL (a pull request, an issue or any page).`,
			"invalid_link",
		);
	const { [sessionPath]: kept = [], ...rest } = store().store;
	const links = [...kept.filter(item => item.url !== link.url), link].slice(-SESSION_LINKS_MAX);
	const others = Object.entries(rest).slice(-(SESSION_LINK_SESSIONS_MAX - 1));
	save({ ...Object.fromEntries(others), [sessionPath]: links });
	return link;
}

/** Removes one link (by the URL as given or as `sessionLink` writes it); an absent one changes nothing. */
export function removeSessionLink(sessionPath: string, url: string): SessionLink[] {
	const all = store().store;
	const kept = all[sessionPath] ?? [];
	const target = sessionLink(url)?.url ?? url.trim();
	const left = kept.filter(item => item.url !== target);
	if (left.length === kept.length) return kept;
	if (left.length > 0) all[sessionPath] = left;
	else delete all[sessionPath];
	save(all);
	return left;
}

/** A deleted session's links go with it. */
export function dropSessionLinks(sessionPath: string): void {
	const all = store().store;
	if (!all[sessionPath]) return;
	delete all[sessionPath];
	save(all);
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
				? sessionLinks()
				: sessionLinks(sessionOf(command, sessionFile));
		case "session_link_add":
			return addSessionLink(sessionOf(command, sessionFile), urlOf(command));
		case "session_link_remove":
			return removeSessionLink(sessionOf(command, sessionFile), urlOf(command));
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
