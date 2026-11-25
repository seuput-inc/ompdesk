/**
 * Links a person or an agent attaches to a session (Orca's workspace references, `src/cli/specs/reference.ts`, MIT),
 * and the pure URL readers the link peek shares: no imports, so the phone's first screen can load it.
 */

export type SessionLinkKind = "pr" | "issue" | "url";

export interface SessionLink {
	url: string;
	kind: SessionLinkKind;
	/** `owner/name` of a pull request or issue. */
	repo?: string;
	number?: number;
}

/** At most this many links per session (the oldest goes). */
export const SESSION_LINKS_MAX = 20;
/** At most this many sessions keep links (the least recently changed go). */
export const SESSION_LINK_SESSIONS_MAX = 2000;

export interface GithubItemLink {
	/** A GitHub Enterprise host (`ghe.example.com[:port]`); absent for github.com. */
	host?: string;
	/** `OWNER/NAME`. */
	repo: string;
	number: number;
}

const GITHUB_ITEM = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:\/.*)?$/;

function parsed(href: string): URL | null {
	try {
		return new URL(href);
	} catch {
		return null;
	}
}

/** `https://<host>/<owner>/<name>/(issues|pull)/<n>` on github.com or an Enterprise host; null for anything else. */
export function githubItemLink(href: string): GithubItemLink | null {
	const url = parsed(href);
	const match = url && (url.protocol === "https:" || url.protocol === "http:") && GITHUB_ITEM.exec(url.pathname);
	if (!url || !match) return null;
	const host = url.host.toLowerCase();
	return {
		...(host === "github.com" || host === "www.github.com" ? {} : { host }),
		repo: `${match[1]}/${match[2]}`,
		number: Number(match[4]),
	};
}

/** The https URL a web card may read, without its fragment; null for anything the core would refuse anyway. */
export function peekableWebUrl(href: string): string | null {
	const url = parsed(href);
	if (!url) return null;
	const host = url.hostname;
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!host.includes(".") ||
		host.startsWith("[") ||
		/^[\d.]+$/.test(host)
	)
		return null;
	url.hash = "";
	return url.toString();
}

/**
 * An https URL as a session link: `/<owner>/<repo>/pull/<n>` on any host is a pull request, `/issues/<n>` an issue,
 * any other https page a plain link; null for anything else (another scheme, not a URL, credentials in it).
 */
export function sessionLink(raw: string): SessionLink | null {
	const url = parsed(raw.trim());
	if (url?.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
	const href = url.toString();
	const match = GITHUB_ITEM.exec(url.pathname);
	if (!match) return { url: href, kind: "url" };
	return {
		url: href,
		kind: match[3] === "pull" ? "pr" : "issue",
		repo: `${match[1]}/${match[2]}`,
		number: Number(match[4]),
	};
}

/** `owner/repo#n` of a pull request or issue, else the URL. */
export function sessionLinkLabel(link: SessionLink): string {
	return link.repo && link.number !== undefined ? `${link.repo}#${link.number}` : link.url;
}
