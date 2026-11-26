/**
 * This computer's Linear and Jira connections (contract `src/shared/trackers.ts`): the accounts in
 * `<userData>/trackers.json` (no secret in it), each token in `<userData>/trackers/<id>.bin` (`secret-files.ts`). The
 * requests themselves run in the core (`trackers.request`, `native/ompdesk/crates/core/src/trackers`), which gets each
 * account's ready `authorization` header per request and keeps nothing of it.
 *
 * Main keeps the accounts because the keystore is main's (native-rust › Ledger: safeStorage stays with the credential
 * consumer). It also answers a list or detail read again within 60 s, a team's states within 10 minutes, and joins a
 * read already under way for the same key (Orca `linear-cache.ts:20-45`, `jira-read-coordination.ts`): one place for
 * every window and a paired phone. Nothing reads on a timer.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { codedError, isIpcErrorCode } from "../shared/ipc-error-codes";
import {
	type JiraAuthType,
	TRACKER_PRESETS,
	TRACKER_PROVIDERS,
	type TrackerAccount,
	type TrackerDraft,
	type TrackerList,
	type TrackerProvider,
	type TrackerSelection,
	type TrackersAccountsRequest,
	type TrackersRequest,
	type TrackersResults,
	type TrackersState,
} from "../shared/trackers";
import { writeFileAtomicSync } from "./atomic-file";
import { type SecretBox, SecretFiles } from "./secret-files";

/** How long a list or an item is answered from memory, and a team's states. */
const READ_FRESH_MS = 60_000;
const STATES_FRESH_MS = 600_000;
/** The core's own bound on one request is 30 s per exchange; a list may page for 20 s more. */
const CORE_TIMEOUT_MS = 90_000;
const LIST_LIMIT = 50;
const LINEAR_KEY = /^[\x21-\x7e]{8,200}$/;
const JIRA_TOKEN = /^[\x20-\x7e]{1,2000}$/;

const provider = z.enum(TRACKER_PROVIDERS);
const accountRef = z.string().regex(/^(linear|jira)-[A-Za-z0-9_-]{24}$/);
/** A Linear issue id or a Jira key: safe in a REST path. */
const itemId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const requestSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("state") }),
	z.object({ action: z.literal("select"), provider, selected: z.union([z.literal("all"), accountRef]) }),
	z.object({
		action: z.literal("list"),
		provider,
		account: z.union([z.literal("all"), accountRef]),
		preset: z.enum(TRACKER_PRESETS),
		search: z.string().max(256).optional(),
		fresh: z.boolean().optional(),
	}),
	z.object({ action: z.literal("detail"), accountId: accountRef, id: itemId, fresh: z.boolean().optional() }),
	z.object({ action: z.literal("states"), accountId: accountRef, id: itemId }),
	z.object({
		action: z.literal("setState"),
		accountId: accountRef,
		id: itemId,
		stateId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	}),
	z.object({
		action: z.literal("comment"),
		accountId: accountRef,
		id: itemId,
		body: z.string().trim().min(1).max(65_536),
	}),
]);
const accountsSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("connect"),
		draft: z.discriminatedUnion("provider", [
			z.object({ provider: z.literal("linear"), apiKey: z.string().max(200) }),
			z.object({
				provider: z.literal("jira"),
				siteUrl: z.string().max(2048),
				email: z.string().max(320),
				token: z.string().max(2000),
				authType: z.enum(["cloud", "server"]),
			}),
		]),
	}),
	z.object({ action: z.literal("remove"), id: accountRef }),
]);

/** What a window or a paired page sent, checked (an id lands in a REST path). */
export function parseTrackersRequest(raw: unknown): TrackersRequest {
	const parsed = requestSchema.safeParse(raw);
	if (!parsed.success) throw new Error(`Invalid trackers request: ${parsed.error.message}`);
	return parsed.data;
}

export function parseTrackersAccountsRequest(raw: unknown): TrackersAccountsRequest {
	const parsed = accountsSchema.safeParse(raw);
	if (!parsed.success) throw new Error("Invalid trackers accounts request");
	return parsed.data;
}
/** The core's answer to one `trackers.request`. */
export type TrackerCoreCall = (params: object, timeoutMs: number) => Promise<unknown>;

export interface TrackerAccountsOptions {
	/** `<userData>`. */
	dir: string;
	box: SecretBox;
	/** Sends `trackers.request` to the core. */
	core: TrackerCoreCall;
	/** The `proxyUrl` preference, for the core's proxy pick. */
	proxyPref: () => unknown;
}

interface Stored {
	id: string;
	provider: TrackerProvider;
	label: string;
	viewer: TrackerAccount["viewer"];
	siteUrl: string;
	authType?: JiraAuthType;
	/** Jira Cloud's gateway, when REST goes through it. */
	apiBaseUrl?: string;
	/** Jira: the sign-in's email (Basic with the token); none for a PAT (Bearer). */
	email?: string;
}

interface StoredFile {
	version: 1;
	accounts: Stored[];
	selected: TrackerSelection;
}

/** A core failure as a coded error the page translates; anything else as it came. */
function coded(error: unknown): Error {
	const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
	const message = error instanceof Error ? error.message : String(error);
	return isIpcErrorCode(code) && code.startsWith("tracker_") ? codedError(code, message) : new Error(message);
}

/** A Jira site address as Orca normalizes it (`site-identity.ts:4-16`): https by default, no credentials, no query. */
export function normalizeJiraSite(input: string): string {
	const trimmed = input.trim();
	const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
		throw new Error("Enter an HTTP or HTTPS Jira site address without credentials");
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

/** Atlassian-hosted sites are always Cloud (`site-identity.ts:18-27`). */
export function jiraAuthType(siteUrl: string, requested: JiraAuthType): JiraAuthType {
	if (requested !== "server") return "cloud";
	return /\.(atlassian\.net|jira\.com)$/.test(new URL(siteUrl).hostname) ? "cloud" : "server";
}

function jiraAuthorization(email: string | undefined, token: string): string {
	return email ? `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}` : `Bearer ${token}`;
}

/** A stable id from what identifies an account; another login on the same site is another account. */
function accountId(provider: TrackerProvider, ...parts: string[]): string {
	return `${provider}-${createHash("sha256").update(parts.join("\n")).digest("base64url").slice(0, 24)}`;
}

export class TrackerAccounts {
	readonly #options: TrackerAccountsOptions;
	#file: StoredFile;
	readonly #secrets: SecretFiles;
	/** Accounts the service refused this run. */
	readonly #refused = new Set<string>();
	readonly #cache = new Map<string, { at: number; value: Promise<unknown> }>();

	constructor(options: TrackerAccountsOptions) {
		this.#options = options;
		this.#file = this.#load();
		this.#secrets = new SecretFiles({
			dir: join(options.dir, "trackers"),
			box: options.box,
			ids: () => this.#file.accounts.map(account => account.id),
		});
	}

	state(): TrackersState {
		return {
			accounts: this.#file.accounts.map(account => ({
				id: account.id,
				provider: account.provider,
				label: account.label,
				viewer: account.viewer,
				siteUrl: account.siteUrl,
				...(account.authType ? { authType: account.authType } : {}),
				...(account.apiBaseUrl ? { gateway: true } : {}),
				needsReconnect: this.#needsReconnect(account.id),
			})),
			selected: this.#file.selected,
		};
	}

	#needsReconnect(id: string): boolean {
		return this.#refused.has(id) || !this.#secrets.has(id) || this.#secrets.needsReentry(id);
	}

	async accounts(request: TrackersAccountsRequest): Promise<TrackersState> {
		if (request.action === "remove") {
			this.#file.accounts = this.#file.accounts.filter(account => account.id !== request.id);
			for (const provider of TRACKER_PROVIDERS)
				if (this.#file.selected[provider] === request.id)
					this.#file.selected[provider] =
						this.#file.accounts.find(account => account.provider === provider)?.id ?? null;
			this.#secrets.remove(request.id);
			this.#refused.delete(request.id);
			this.#cache.clear();
			this.#write();
			return this.state();
		}
		const stored = await this.#verify(request.draft);
		this.#secrets.save(
			stored.id,
			request.draft.provider === "linear" ? request.draft.apiKey.trim() : request.draft.token.trim(),
		);
		this.#file.accounts = [...this.#file.accounts.filter(account => account.id !== stored.id), stored];
		// A newly connected account is the one shown (Orca `upsert(workspace, {select: true})`).
		this.#file.selected[stored.provider] = stored.id;
		this.#refused.delete(stored.id);
		this.#cache.clear();
		this.#write();
		return this.state();
	}

	async #verify(draft: TrackerDraft): Promise<Stored> {
		if (draft.provider === "linear") {
			const key = String(draft.apiKey ?? "").trim();
			if (!LINEAR_KEY.test(key)) throw new Error("Enter a Linear API key");
			const verified = (await this.#core({ op: "linear_verify", authorization: key })) as {
				viewer: { id: string; name: string; email: string };
				org: { id: string; name: string; urlKey: string };
			};
			return {
				id: accountId("linear", verified.org.id, verified.viewer.id),
				provider: "linear",
				label: verified.org.name || verified.org.urlKey,
				viewer: {
					id: verified.viewer.id,
					name: verified.viewer.name,
					...(verified.viewer.email ? { email: verified.viewer.email } : {}),
				},
				siteUrl: `https://linear.app/${encodeURIComponent(verified.org.urlKey)}`,
			};
		}
		const siteUrl = normalizeJiraSite(String(draft.siteUrl ?? ""));
		const authType = jiraAuthType(siteUrl, draft.authType === "server" ? "server" : "cloud");
		const email = String(draft.email ?? "").trim();
		const token = String(draft.token ?? "").trim();
		if (!JIRA_TOKEN.test(token) || /[\r\n]/.test(email) || email.length > 320)
			throw new Error(email || authType === "cloud" ? "Enter the API token" : "Enter the personal access token");
		const verified = (await this.#core({
			op: "jira_verify",
			siteUrl,
			authorization: jiraAuthorization(email, token),
			server: authType === "server",
			email: email !== "",
		})) as { viewer: { id: string; name: string; email: string }; apiBaseUrl: string | null };
		return {
			// Sha-256 of site and login, so another account on the same host stays apart (`site-identity.ts:29-35`).
			id: accountId("jira", siteUrl, (email || verified.viewer.id).toLowerCase()),
			provider: "jira",
			label: new URL(siteUrl).host,
			viewer: {
				id: verified.viewer.id,
				name: verified.viewer.name || email || verified.viewer.id,
				...(verified.viewer.email || email ? { email: verified.viewer.email || email } : {}),
			},
			siteUrl,
			authType,
			...(verified.apiBaseUrl ? { apiBaseUrl: verified.apiBaseUrl } : {}),
			...(email ? { email } : {}),
		};
	}

	async command<R extends TrackersRequest>(request: R): Promise<TrackersResults[R["action"]]> {
		return (await this.#command(request)) as TrackersResults[R["action"]];
	}

	async #command(request: TrackersRequest): Promise<unknown> {
		switch (request.action) {
			case "state":
				return this.state();
			case "select": {
				const valid =
					request.selected === "all" ||
					this.#file.accounts.some(
						account => account.id === request.selected && account.provider === request.provider,
					);
				if (valid) {
					this.#file.selected[request.provider] = request.selected;
					this.#write();
				}
				return this.state();
			}
			case "list": {
				const accounts = this.#file.accounts.filter(
					account =>
						account.provider === request.provider &&
						(request.account === "all" ? !this.#needsReconnect(account.id) : account.id === request.account),
				);
				if (accounts.length === 0) return { items: [], hasMore: false, errors: [] } satisfies TrackerList;
				const key = JSON.stringify([
					"list",
					request.provider,
					request.account,
					request.preset,
					request.search ?? "",
				]);
				const list = (await this.#cached(key, READ_FRESH_MS, request.fresh === true, () =>
					this.#core(
						{
							op: "list",
							provider: request.provider,
							accounts: accounts.map(account => this.#wire(account)),
							preset: request.preset,
							...(request.search?.trim() ? { search: request.search.trim().slice(0, 256) } : {}),
							limit: LIST_LIMIT,
						},
						accounts,
					),
				)) as TrackerList;
				for (const error of list.errors) if (error.type === "auth") this.#refused.add(error.accountId);
				return list;
			}
			case "detail":
				return this.#one(request.accountId, request.id, "detail", READ_FRESH_MS, request.fresh === true);
			case "states":
				return this.#one(request.accountId, request.id, "states", STATES_FRESH_MS, false);
			case "setState":
			case "comment": {
				const account = this.#account(request.accountId);
				this.#cache.clear();
				return this.#core(
					request.action === "setState"
						? {
								op: "set_state",
								provider: account.provider,
								account: this.#wire(account),
								id: request.id,
								stateId: request.stateId,
							}
						: {
								op: "comment",
								provider: account.provider,
								account: this.#wire(account),
								id: request.id,
								body: request.body,
							},
					[account],
				);
			}
		}
	}

	#one(id: string, item: string, op: "detail" | "states", freshMs: number, fresh: boolean): Promise<unknown> {
		const account = this.#account(id);
		// A team's states are the same for each of its issues; the key keeps the issue, which names the team.
		return this.#cached(JSON.stringify([op, id, item]), freshMs, fresh, () =>
			this.#core({ op, provider: account.provider, account: this.#wire(account), id: item }, [account]),
		);
	}

	#account(id: string): Stored {
		const account = this.#file.accounts.find(item => item.id === id);
		if (!account) throw codedError("tracker_failed", "That account is no longer connected");
		return account;
	}

	/** The account as the core gets it, with its `authorization`; never part of state, an event or a log. */
	#wire(account: Stored) {
		let token: string;
		try {
			token = this.#secrets.read(account.id);
		} catch {
			throw codedError("tracker_auth", `${account.label}: connect it again`);
		}
		return {
			id: account.id,
			label: account.label,
			base: account.apiBaseUrl ?? account.siteUrl,
			siteUrl: account.siteUrl,
			server: account.authType === "server",
			authorization: account.provider === "linear" ? token : jiraAuthorization(account.email, token),
		};
	}

	/** Answers `key` from a read under way or one younger than `freshMs`; a failed read is not kept. */
	#cached(key: string, freshMs: number, fresh: boolean, read: () => Promise<unknown>): Promise<unknown> {
		const now = Date.now();
		const kept = this.#cache.get(key);
		if (kept && !fresh && now - kept.at < freshMs) return kept.value;
		const value = read();
		this.#cache.set(key, { at: now, value });
		value.catch(() => {
			if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
		});
		return value;
	}

	async #core(params: object, accounts: Stored[] = []): Promise<unknown> {
		try {
			return await this.#options.core({ ...params, proxyPref: this.#options.proxyPref() ?? null }, CORE_TIMEOUT_MS);
		} catch (error) {
			const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code === "tracker_auth" && accounts.length === 1) this.#refused.add(accounts[0].id);
			throw coded(error);
		}
	}

	#path(): string {
		return join(this.#options.dir, "trackers.json");
	}

	#load(): StoredFile {
		const empty: StoredFile = { version: 1, accounts: [], selected: { linear: null, jira: null } };
		try {
			const parsed = JSON.parse(readFileSync(this.#path(), "utf8")) as Partial<StoredFile>;
			const accounts = (Array.isArray(parsed.accounts) ? parsed.accounts : []).filter(
				(item): item is Stored =>
					typeof item?.id === "string" &&
					TRACKER_PROVIDERS.includes(item.provider) &&
					typeof item.label === "string" &&
					typeof item.siteUrl === "string" &&
					typeof item.viewer?.id === "string",
			);
			const selected = { ...empty.selected };
			for (const provider of TRACKER_PROVIDERS) {
				const value = parsed.selected?.[provider];
				if (value === "all" || accounts.some(account => account.id === value && account.provider === provider))
					selected[provider] = value ?? null;
				else selected[provider] = accounts.find(account => account.provider === provider)?.id ?? null;
			}
			return { version: 1, accounts, selected };
		} catch {
			return empty;
		}
	}

	#write(): void {
		writeFileAtomicSync(this.#path(), JSON.stringify(this.#file, null, 2), { mode: 0o600 });
	}
}
