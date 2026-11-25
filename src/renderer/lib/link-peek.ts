/**
 * What a link points to, for the card it shows on hover or keyboard focus (Orca's link peek,
 * `native-chat/links/previews/native-chat-hover-preview-cache.ts`, `native-chat-web-link-preview.ts`, MIT). A GitHub
 * issue or pull request is read with the `github` command's `item_peek` (one REST read on the tab's computer, with
 * that computer's `gh`); any other https page through the core's `webPeek.get` (`web_peek` command), which reads only
 * public addresses. Each answer is kept per URL for 10 minutes; a failure is not kept, so the next card asks again.
 */
import { useEffect, useRef, useState } from "react";
import type { GithubItemPeek } from "../../shared/github";
import type { RpcWebPeek } from "../../shared/rpc-types";
import { github } from "./github";

export const LINK_PEEK_FRESH_MS = 10 * 60_000;

export interface GithubItemLink {
	/** A GitHub Enterprise host (`ghe.example.com[:port]`); absent for github.com. */
	host?: string;
	/** `OWNER/NAME`. */
	repo: string;
	number: number;
}

const GITHUB_ITEM = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)(?:\/.*)?$/;

/** `https://<host>/<owner>/<name>/(issues|pull)/<n>` on github.com or an Enterprise host; null for anything else. */
export function githubItemLink(href: string): GithubItemLink | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
	const match = (url.protocol === "https:" || url.protocol === "http:") && GITHUB_ITEM.exec(url.pathname);
	if (!match) return null;
	const host = url.host.toLowerCase();
	return {
		...(host === "github.com" || host === "www.github.com" ? {} : { host }),
		repo: `${match[1]}/${match[2]}`,
		number: Number(match[3]),
	};
}

/** The https URL a web card may read, without its fragment; null for anything the core would refuse anyway. */
export function peekableWebUrl(href: string): string | null {
	let url: URL;
	try {
		url = new URL(href);
	} catch {
		return null;
	}
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

interface Entry {
	at: number;
	promise: Promise<unknown>;
	value?: unknown;
}

const answers = new Map<string, Entry>();

/** One read per key while its answer is younger than `freshMs`; a failed read is forgotten. */
function remembered<T>(key: string, freshMs: number, load: () => Promise<T>): Promise<T> {
	const hit = answers.get(key);
	if (hit && Date.now() - hit.at < freshMs) return hit.promise as Promise<T>;
	const entry: Entry = { at: Date.now(), promise: load() };
	answers.set(key, entry);
	entry.promise.then(
		value => {
			entry.value = value;
		},
		() => {
			if (answers.get(key) === entry) answers.delete(key);
		},
	);
	return entry.promise as Promise<T>;
}

export const githubPeekKey = (link: GithubItemLink) =>
	`github:${link.host ?? ""}:${link.repo.toLowerCase()}#${link.number}`;
export const webPeekKey = (url: string) => `web:${url}`;

/** `freshMs`: how old a kept answer may be (a live PR card asks every minute); `background`: no person asked. */
export function peekGithubItem(
	link: GithubItemLink,
	options: { freshMs?: number; background?: boolean } = {},
): Promise<GithubItemPeek> {
	return remembered(githubPeekKey(link), options.freshMs ?? LINK_PEEK_FRESH_MS, () =>
		github(
			{ op: "item_peek", number: link.number, repo: link.repo, ...(link.host ? { host: link.host } : {}) },
			options.background,
		),
	);
}

export function peekWebPage(url: string): Promise<RpcWebPeek | null> {
	return remembered(webPeekKey(url), LINK_PEEK_FRESH_MS, async () => {
		const response = await window.omp.rpc.command({ type: "web_peek", url });
		if (!response.success) throw new Error(response.error);
		return (response.data ?? null) as RpcWebPeek | null;
	});
}

export type PeekState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed" };

function keptState<T>(key: string): PeekState<T> {
	const kept = answers.get(key);
	return kept && "value" in kept ? { status: "ready", value: kept.value as T } : { status: "loading" };
}

/** A card's read: an answer kept from before paints at once, else loading until `load` settles. */
export function usePeek<T>(key: string, load: () => Promise<T>): PeekState<T> {
	const [held, setHeld] = useState<{ key: string; state: PeekState<T> }>(() => ({ key, state: keptState(key) }));
	const loadRef = useRef(load);
	loadRef.current = load;
	useEffect(() => {
		let live = true;
		loadRef.current().then(
			value => {
				if (live) setHeld({ key, state: { status: "ready", value } });
			},
			() => {
				if (live) setHeld({ key, state: { status: "failed" } });
			},
		);
		return () => {
			live = false;
		};
	}, [key]);
	return held.key === key ? held.state : keptState(key);
}
