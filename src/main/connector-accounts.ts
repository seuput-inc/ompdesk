/**
 * What a bot's connectors need that is not a routine (contract `src/shared/bot-connectors.ts`): the Slack apps and the
 * Google sign-ins the owner made for bots, in `<userData>/bot-connectors.json` (no secret in it), each token in
 * `<userData>/bot-connectors/<id>-<kind>.bin` encrypted by the OS keystore (`secret-files.ts`). Main reads a file
 * chosen by the owner in the native shell. The shell's secure storage and the core's private provider requests
 * handle credential bytes; renderer, paired and agent IPC carry only the action and nonsecret account metadata.
 *
 * Main keeps them because the keystore is main's (native-rust › Ledger: safeStorage stays with the credential
 * consumer); the requests run in the core (`routines/connectors.rs`, `routines/google.rs`).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { constants, promises as fs } from "original-fs";
import { z } from "zod";
import {
	type BotConnectorsRequest,
	type BotConnectorsState,
	GMAIL_ACCOUNT,
	type GoogleAccount,
	type SlackApp,
} from "../shared/bot-connectors";
import { writeFileAtomicSync } from "./atomic-file";
import { type SecretBox, SecretFiles, SecretReadError } from "./secret-files";

type Stored = Pick<SlackApp, "id" | "team" | "teamId" | "botUserId">;
type StoredGoogle = Pick<GoogleAccount, "id" | "email"> & { clientId: string };
type Secret = "bot" | "app" | "signing";
type GoogleSecret = "client" | "refresh";

const SECRETS: readonly Secret[] = ["bot", "app", "signing"];
const GOOGLE_SECRETS: readonly GoogleSecret[] = ["client", "refresh"];
/** A Slack token's shape: what Slack's own settings page shows, nothing a line break or a space could ride in. */
const TOKEN = /^[\x21-\x7e]{10,300}$/;
/** How long Google's sign-in may wait for the person in the browser (the core gives up after ten minutes). */
const SIGN_IN_TIMEOUT_MS = 11 * 60_000;

const slackFile = z
	.object({
		botToken: z.string().max(400).optional(),
		appToken: z.string().min(1).max(400).optional(),
		signingSecret: z.string().min(1).max(400).optional(),
	})
	.strict();
const slackId = z.string().regex(/^slack-[0-9a-f]{16}$/);
const googleId = z.string().regex(/^google-[0-9a-f]{16}$/);
const requestSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("list") }).strict(),
	z.object({ action: z.literal("importSlack"), mode: z.enum(["socket", "url"]), id: slackId.optional() }).strict(),
	z.object({ action: z.literal("importLinear") }).strict(),
	z.object({ action: z.literal("removeSlack"), id: slackId }).strict(),
	z.object({ action: z.literal("signInGoogle"), id: googleId.optional() }).strict(),
	z.object({ action: z.literal("cancelGoogle") }).strict(),
	z.object({ action: z.literal("removeGoogle"), id: googleId }).strict(),
]);

/** A window's request, checked before main acts on it (IPC is a trust boundary: the paired phone's page is one). */
export function parseBotConnectorsRequest(request: unknown): BotConnectorsRequest {
	const parsed = requestSchema.safeParse(request);
	if (!parsed.success) throw new Error("Invalid bot connectors request");
	return parsed.data;
}

type Picker = () => Promise<string | null>;

/** Only a local page has a native owner window. Neither a peer nor an agent can open the picker. */
export function connectorCommand(
	caller: { browserWindow: unknown; connId?: string | undefined },
	raw: unknown,
	accounts: Pick<ConnectorAccounts, "command">,
	pick: Picker,
): Promise<BotConnectorsState> {
	const request = parseBotConnectorsRequest(raw);
	if (request.action !== "list" && (!caller.browserWindow || caller.connId !== undefined))
		throw new Error("Manage connector credentials on the computer the bot runs on");
	return accounts.command(request, pick);
}

export interface ConnectorAccountsOptions {
	/** `<userData>`. */
	dir: string;
	box: SecretBox;
	/** One request to the core (`connectors.slackCheck`, `connectors.google*`). */
	core: (method: string, params: object, timeoutMs?: number) => Promise<unknown>;
	/** Opens Google's sign-in page in the person's browser. */
	openExternal?: (url: string) => Promise<void>;
	connectLinear?: (apiKey: string) => Promise<string>;
	/** Told after every change. */
	onChange?: (state: BotConnectorsState) => void;
}

export class ConnectorAccounts {
	readonly #options: ConnectorAccountsOptions;
	#apps: Stored[];
	#google: StoredGoogle[];
	readonly #secrets: SecretFiles;
	/** The Google sign-in under way (the core's flow id); one at a time. */
	#signingIn: string | null = null;

	constructor(options: ConnectorAccountsOptions) {
		this.#options = options;
		const kept = this.#load();
		this.#apps = kept.slack;
		this.#google = kept.google;
		this.#secrets = new SecretFiles({
			dir: join(options.dir, "bot-connectors"),
			box: options.box,
			ids: () => [
				...this.#apps.flatMap(app => SECRETS.map(kind => key(app.id, kind))),
				...this.#google.flatMap(account => GOOGLE_SECRETS.map(kind => key(account.id, kind))),
			],
		});
	}

	state(): BotConnectorsState {
		return {
			slack: this.#apps.map(app => {
				const needsReentry = SECRETS.some(kind => this.#secrets.needsReentry(key(app.id, kind)));
				return {
					id: app.id,
					team: app.team,
					teamId: app.teamId,
					botUserId: app.botUserId,
					socketMode: !needsReentry && this.#secrets.has(key(app.id, "app")),
					signingSecret: !needsReentry && this.#secrets.has(key(app.id, "signing")),
					needsReentry,
				};
			}),
			google: this.#google.map(({ id, email }) => ({
				id,
				email,
				needsReentry: GOOGLE_SECRETS.some(kind => this.#secrets.needsReentry(key(id, kind))),
			})),
		};
	}

	async command(request: BotConnectorsRequest, pick?: Picker): Promise<BotConnectorsState> {
		if (request.action === "importSlack" || request.action === "importLinear" || request.action === "signInGoogle") {
			try {
				if (request.action === "signInGoogle" && request.id) return await this.#signInGoogle({ id: request.id });
				if (!pick) throw new Error();
				const path = await pick();
				if (!path) return this.state();
				const file = await fs.open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
				let text: string;
				try {
					const stat = await file.stat();
					if (!stat.isFile() || !stat.size || stat.size > 20_000) throw new Error();
					const bytes = Buffer.alloc(stat.size);
					if ((await file.read(bytes)).bytesRead !== bytes.length) throw new Error();
					text = bytes.toString("utf8").trim();
				} finally {
					await file.close();
				}
				if (request.action === "signInGoogle") return await this.#signInGoogle({ clientFile: text });
				if (request.action === "importLinear") {
					if (!this.#options.connectLinear) throw new Error();
					return { ...this.state(), importedId: await this.#options.connectLinear(text) };
				}
				const credentials = slackFile.parse(JSON.parse(text));
				const required = request.mode === "socket" ? "appToken" : "signingSecret";
				if (!credentials[required] && !(request.id && this.slackTokens(request.id)?.[required])) throw new Error();
				return await this.#saveSlack({ ...credentials, id: request.id });
			} catch {
				// Neither a parser's input excerpt, a local path nor a provider's error body leaves this operation.
				throw new Error("Could not connect the account. Check the credential file and sign-in, then try again.");
			}
		}
		switch (request.action) {
			case "list":
				return this.state();
			case "removeSlack":
				this.#apps = this.#apps.filter(app => app.id !== request.id);
				for (const kind of SECRETS) this.#secrets.remove(key(request.id, kind));
				this.#write();
				return this.state();
			case "cancelGoogle":
				if (this.#signingIn) await this.#options.core("connectors.googleSignInCancel", { flow: this.#signingIn });
				return this.state();
			case "removeGoogle":
				this.#google = this.#google.filter(account => account.id !== request.id);
				for (const kind of GOOGLE_SECRETS) this.#secrets.remove(key(request.id, kind));
				this.#write();
				return this.state();
		}
	}

	async #signInGoogle(request: { id?: string; clientFile?: string }): Promise<BotConnectorsState> {
		if (this.#signingIn) throw new Error("A Google sign-in is already waiting in the browser");
		let client: { clientId: string; clientSecret: string };
		if (request.clientFile !== undefined) client = parseGoogleClientFile(request.clientFile);
		else {
			const kept = this.#google.find(account => account.id === request.id);
			if (!kept) throw new Error("Choose the Google app's client file (client_secret_….json)");
			client = { clientId: kept.clientId, clientSecret: this.#read(kept.id, "client", "Google") ?? "" };
			if (!client.clientSecret) throw new Error("Choose the Google app's client file (client_secret_….json)");
		}
		const { flow, url } = (await this.#options.core("connectors.googleSignIn", client)) as {
			flow: string;
			url: string;
		};
		this.#signingIn = flow;
		try {
			await this.#options.openExternal?.(url);
			const signed = (await this.#options.core("connectors.googleSignInWait", { flow }, SIGN_IN_TIMEOUT_MS)) as {
				refreshToken: string;
				email: string;
			};
			const email = signed.email.trim().toLowerCase();
			const id =
				this.#google.find(account => account.email === email)?.id ??
				`google-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
			this.#secrets.save(key(id, "client"), client.clientSecret);
			this.#secrets.save(key(id, "refresh"), signed.refreshToken);
			this.#google = [
				...this.#google.filter(account => account.id !== id),
				{ id, email, clientId: client.clientId },
			];
			this.#write();
			return { ...this.state(), importedId: id };
		} catch (error) {
			// The browser never opened, or main gave up first: the core's listener goes too.
			await this.#options.core("connectors.googleSignInCancel", { flow }).catch(() => undefined);
			throw error;
		} finally {
			this.#signingIn = null;
		}
	}

	/**
	 * Main → core only, for one access token (`routineAsk` `google`): the account's client and refresh token, by its
	 * e-mail or id. Never part of state, an event, a log or an answer to a window.
	 */
	googleSign(account: string): { clientId: string; clientSecret: string; refreshToken: string } {
		const wanted = account.trim().toLowerCase();
		const kept = this.#google.find(item => item.email === wanted || item.id === account);
		if (!kept) throw new Error(`no Google account ${account} is signed in for bots; sign in on the bot's page`);
		const clientSecret = this.#read(kept.id, "client", "Google");
		const refreshToken = this.#read(kept.id, "refresh", "Google");
		if (!clientSecret || !refreshToken) throw new Error(`sign in to Google (${kept.email}) again on the bot's page`);
		return { clientId: kept.clientId, clientSecret, refreshToken };
	}

	/**
	 * An email routine's mailbox when its account is a Google sign-in (`google:<email>`): Gmail's IMAP with a fresh
	 * access token (XOAUTH2, `routines/imap`). Null for any other account name.
	 */
	async gmailMailbox(name: string): Promise<object | null> {
		if (!name.startsWith(GMAIL_ACCOUNT)) return null;
		const email = name.slice(GMAIL_ACCOUNT.length).trim().toLowerCase();
		const { accessToken } = (await this.#options.core("connectors.googleToken", this.googleSign(email))) as {
			accessToken: string;
		};
		return {
			id: `${GMAIL_ACCOUNT}${email}`,
			label: `Gmail (${email})`,
			address: email,
			connection: {
				host: "imap.gmail.com",
				port: 993,
				plainLoopback: false,
				login: { username: email, password: accessToken, mailbox: "INBOX", oauth: true },
				timeoutMs: 30_000,
			},
		};
	}

	async #saveSlack(request: z.infer<typeof slackFile> & { id?: string | undefined }): Promise<BotConnectorsState> {
		const existing = request.id === undefined ? undefined : this.#apps.find(app => app.id === request.id);
		if (request.id !== undefined && !existing) throw new Error("That Slack app is no longer kept");
		const token = (value: string | undefined, prefix: string, what: string): string | undefined => {
			if (value === undefined) return undefined;
			const text = value.trim();
			if (!TOKEN.test(text) || !text.startsWith(prefix)) throw new Error(`Invalid ${what}`);
			return text;
		};
		const bot = token(request.botToken, "xoxb-", "bot token (xoxb-…)");
		const app = token(request.appToken, "xapp-", "app-level token (xapp-…)");
		const signing = token(request.signingSecret, "", "signing secret");
		if (!existing && !bot) throw new Error("Enter the bot token (xoxb-…)");
		let stored = existing;
		if (bot) {
			// Slack says whose workspace and bot user the token is before anything is kept.
			const checked = (await this.#options.core("connectors.slackCheck", {
				botToken: bot,
				...(app ? { appToken: app } : {}),
			})) as { teamId: string; team: string; userId: string };
			if (existing && (existing.teamId !== checked.teamId || existing.botUserId !== checked.userId))
				throw new Error("Choose the credential file for this Slack app");
			const same = this.#apps.find(kept => kept.teamId === checked.teamId && kept.botUserId === checked.userId);
			stored = {
				id: existing?.id ?? same?.id ?? `slack-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
				team: checked.team,
				teamId: checked.teamId,
				botUserId: checked.userId,
			};
			this.#secrets.save(key(stored.id, "bot"), bot);
		}
		if (!stored) throw new Error("Enter the bot token (xoxb-…)");
		const id = stored.id;
		for (const [kind, value] of [
			["app", app],
			["signing", signing],
		] as const) {
			if (value !== undefined) this.#secrets.save(key(id, kind), value);
		}
		const saved = stored;
		this.#apps = [...this.#apps.filter(kept => kept.id !== id), saved];
		this.#write();
		return { ...this.state(), importedId: id };
	}

	/**
	 * Main → core only, for one Socket Mode connection, one reply or one signed call: the app's tokens, or null when it
	 * is not kept. Never part of state, an event, a log or an answer to a window.
	 */
	slackTokens(id: string): { botToken: string; appToken: string | null; signingSecret: string | null } | null {
		if (!this.#apps.some(app => app.id === id)) return null;
		const botToken = this.#read(id, "bot", "Slack");
		if (!botToken) return null;
		return { botToken, appToken: this.#read(id, "app", "Slack"), signingSecret: this.#read(id, "signing", "Slack") };
	}

	/** One kept token; null when none is kept. */
	#read(id: string, kind: Secret | GoogleSecret, service: "Slack" | "Google"): string | null {
		try {
			return this.#secrets.read(key(id, kind));
		} catch (error) {
			if (error instanceof SecretReadError && error.reason === "missing") return null;
			const again = service === "Slack" ? "enter them again on the bot's page" : "sign in again on the bot's page";
			throw new Error(
				error instanceof SecretReadError && error.reason === "blocked"
					? `the ${service} tokens cannot be read without macOS asking for your login password; ${again}`
					: `the ${service} tokens could not be read on this computer; ${again}`,
			);
		}
	}

	#file(): string {
		return join(this.#options.dir, "bot-connectors.json");
	}

	#load(): { slack: Stored[]; google: StoredGoogle[] } {
		try {
			const parsed = JSON.parse(readFileSync(this.#file(), "utf8")) as { slack?: unknown; google?: unknown };
			const list = (value: unknown): Record<string, unknown>[] =>
				Array.isArray(value) ? value.filter(item => typeof item === "object" && item !== null) : [];
			return {
				slack: list(parsed.slack).filter(
					(app): app is Stored =>
						typeof app.id === "string" &&
						/^slack-[0-9a-f]{16}$/.test(app.id) &&
						typeof app.team === "string" &&
						typeof app.teamId === "string" &&
						typeof app.botUserId === "string",
				),
				google: list(parsed.google).filter(
					(account): account is StoredGoogle =>
						typeof account.id === "string" &&
						/^google-[0-9a-f]{16}$/.test(account.id) &&
						typeof account.email === "string" &&
						typeof account.clientId === "string",
				),
			};
		} catch {
			return { slack: [], google: [] };
		}
	}

	#write(): void {
		writeFileAtomicSync(
			this.#file(),
			JSON.stringify({ version: 1, slack: this.#apps, google: this.#google }, null, 2),
			{ mode: 0o600 },
		);
		this.#options.onChange?.(this.state());
	}
}

function key(id: string, kind: Secret | GoogleSecret): string {
	return `${id}-${kind}`;
}

/**
 * The client of the JSON file Google Cloud downloads for a Desktop OAuth client (Orca
 * `main/google/google-client-file.ts:1-86`): `installed.client_id` and `installed.client_secret`. A Web application
 * client cannot sign in through this computer's loopback, so it is refused with what to make instead.
 */
export function parseGoogleClientFile(text: string): { clientId: string; clientSecret: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("That is not the client file Google Cloud downloads (client_secret_….json)");
	}
	const root = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
	if (root.web !== undefined && root.installed === undefined)
		throw new Error("That is a Web application client; make a Desktop app client in Google Cloud instead");
	const installed = (typeof root.installed === "object" && root.installed !== null ? root.installed : {}) as Record<
		string,
		unknown
	>;
	const clientId = typeof installed.client_id === "string" ? installed.client_id.trim() : "";
	const clientSecret = typeof installed.client_secret === "string" ? installed.client_secret.trim() : "";
	if (!clientId.endsWith(".apps.googleusercontent.com") || !TOKEN.test(clientSecret))
		throw new Error("That is not the client file Google Cloud downloads (client_secret_….json)");
	return { clientId, clientSecret };
}
