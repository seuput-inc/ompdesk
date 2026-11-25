import { core } from "../core/process";

/** One poll of a mailbox: everything a connection needs and nothing kept after it. */
export interface ImapLogin {
	username: string;
	password: string;
	mailbox: string;
}

/** Where the mailbox stands: a UID past `uid` is new, unless `validity` changed (then the UIDs mean other mail). */
export interface MailCursor {
	validity: number;
	uid: number;
}

export interface MailMessage {
	uid: number;
	/** Header fields, lower-cased names, RFC 2047 words decoded, folded lines joined. */
	headers: Record<string, string>;
	/** The start of its plain text (a text/plain part's when it has one), decoded, at most `SNIPPET_CHARS`. */
	snippet: string;
}

export interface MailboxRead {
	cursor: MailCursor;
	/** Mail past the cursor, oldest first (none when there was no cursor: that read is the baseline). */
	messages: MailMessage[];
	/** How many messages the mailbox holds (`EXISTS`). */
	exists: number;
}

export interface ImapEndpoint {
	host: string;
	port: number;
	/** Test launches only. The core ignores host and connects to IPv4 loopback. */
	plainLoopback?: boolean;
}

/** A server's refusal or a broken exchange, in words that never hold the password. */
export class ImapError extends Error {}

/**
 * One read of the mailbox. Without a cursor (or after the mailbox's UIDVALIDITY changed) it only records where the
 * mailbox stands; with one it returns the mail past it.
 */
export async function readMailbox(
	endpoint: ImapEndpoint,
	login: ImapLogin,
	cursor: MailCursor | null,
	timeoutMs = 30_000,
): Promise<MailboxRead> {
	try {
		const { result } = await core().call<MailboxRead>(
			"routines.readMailbox",
			{ account: { ...endpoint, plainLoopback: endpoint.plainLoopback ?? false, login, timeoutMs }, cursor },
			{ timeoutMs: 10 * 60_000 },
		);
		return result;
	} catch (error) {
		throw new ImapError(error instanceof Error ? error.message : String(error));
	}
}
