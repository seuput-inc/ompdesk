/**
 * What a bot's connectors need that is not a routine (contract `src/shared/bot-connectors.ts`): the Slack apps the
 * owner made for bots, in `<userData>/bot-connectors.json` (no secret in it), each token in
 * `<userData>/bot-connectors/<app>-<kind>.bin` encrypted by the OS keystore (`secret-files.ts`). A token goes one way:
 * typed in the setup sheet, sent to main once, handed to the core only for the one connection or post that needs it
 * (`routineAsk` `slack`, `connectorCredential`, a Slack-signed `/hooks` call), never to a window, an agent or a log.
 *
 * Main keeps them because the keystore is main's (native-rust › Ledger: safeStorage stays with the credential
 * consumer); the requests run in the core (`routines/connectors.rs`).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { BotConnectorsRequest, BotConnectorsState, SlackApp } from "../shared/bot-connectors";
import { writeFileAtomicSync } from "./atomic-file";
import { type SecretBox, SecretFiles, SecretReadError } from "./secret-files";

type Stored = Pick<SlackApp, "id" | "team" | "teamId" | "botUserId">;
type Secret = "bot" | "app" | "signing";

const SECRETS: readonly Secret[] = ["bot", "app", "signing"];
/** A Slack token's shape: what Slack's own settings page shows, nothing a line break or a space could ride in. */
const TOKEN = /^[\x21-\x7e]{10,300}$/;

const tokenField = z.string().max(400).optional();
const requestSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("list") }).strict(),
	z
		.object({
			action: z.literal("saveSlack"),
			id: z.string().max(64).optional(),
			botToken: tokenField,
			appToken: tokenField,
			signingSecret: tokenField,
		})
		.strict(),
	z.object({ action: z.literal("removeSlack"), id: z.string().max(64) }).strict(),
]);

/** A window's request, checked before main acts on it (IPC is a trust boundary: the paired phone's page is one). */
export function parseBotConnectorsRequest(request: unknown): BotConnectorsRequest {
	const parsed = requestSchema.safeParse(request);
	if (!parsed.success) throw new Error("Invalid bot connectors request");
	return parsed.data;
}

export interface ConnectorAccountsOptions {
	/** `<userData>`. */
	dir: string;
	box: SecretBox;
	/** One request to the core (`connectors.slackCheck`). */
	core: (method: string, params: object) => Promise<unknown>;
	/** Told after every change. */
	onChange?: (state: BotConnectorsState) => void;
}

export class ConnectorAccounts {
	readonly #options: ConnectorAccountsOptions;
	#apps: Stored[];
	readonly #secrets: SecretFiles;

	constructor(options: ConnectorAccountsOptions) {
		this.#options = options;
		this.#apps = this.#load();
		this.#secrets = new SecretFiles({
			dir: join(options.dir, "bot-connectors"),
			box: options.box,
			ids: () => this.#apps.flatMap(app => SECRETS.map(kind => key(app.id, kind))),
		});
	}

	state(): BotConnectorsState {
		return {
			slack: this.#apps.map(app => {
				const needsReentry = SECRETS.some(kind => this.#secrets.needsReentry(key(app.id, kind)));
				return {
					...app,
					socketMode: !needsReentry && this.#secrets.has(key(app.id, "app")),
					signingSecret: !needsReentry && this.#secrets.has(key(app.id, "signing")),
					needsReentry,
				};
			}),
		};
	}

	async command(request: BotConnectorsRequest): Promise<BotConnectorsState> {
		switch (request.action) {
			case "list":
				return this.state();
			case "saveSlack":
				return this.#saveSlack(request);
			case "removeSlack":
				this.#apps = this.#apps.filter(app => app.id !== request.id);
				for (const kind of SECRETS) this.#secrets.remove(key(request.id, kind));
				this.#write();
				return this.state();
		}
	}

	async #saveSlack(request: Extract<BotConnectorsRequest, { action: "saveSlack" }>): Promise<BotConnectorsState> {
		const existing = request.id === undefined ? undefined : this.#apps.find(app => app.id === request.id);
		if (request.id !== undefined && !existing) throw new Error("That Slack app is no longer kept");
		const token = (value: unknown, prefix: string, what: string): string | null | undefined => {
			if (value === undefined) return undefined;
			const text = String(value).trim();
			if (text === "") return null;
			if (!TOKEN.test(text) || (prefix && !text.startsWith(prefix))) throw new Error(`Enter the ${what}`);
			return text;
		};
		const bot = token(request.botToken, "xoxb-", "bot token (xoxb-…)");
		const app = token(request.appToken, "xapp-", "app-level token (xapp-…)");
		const signing = token(request.signingSecret, "", "signing secret");
		if (!existing && !bot) throw new Error("Enter the bot token (xoxb-…)");
		if (existing && bot === null) throw new Error("A Slack app keeps its bot token; remove the app instead");
		let stored = existing;
		if (bot) {
			// Slack says whose workspace and bot user the token is before anything is kept.
			const checked = (await this.#options.core("connectors.slackCheck", {
				botToken: bot,
				...(app ? { appToken: app } : {}),
			})) as { teamId: string; team: string; userId: string };
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
			if (value === null) this.#secrets.remove(key(id, kind));
			else if (value !== undefined) this.#secrets.save(key(id, kind), value);
		}
		const saved = stored;
		this.#apps = [...this.#apps.filter(kept => kept.id !== id), saved];
		this.#write();
		return this.state();
	}

	/**
	 * Main → core only, for one Socket Mode connection, one reply or one signed call: the app's tokens, or null when it
	 * is not kept. Never part of state, an event, a log or an answer to a window.
	 */
	slackTokens(id: string): { botToken: string; appToken: string | null; signingSecret: string | null } | null {
		if (!this.#apps.some(app => app.id === id)) return null;
		const read = (kind: Secret): string | null => {
			try {
				return this.#secrets.read(key(id, kind));
			} catch (error) {
				if (error instanceof SecretReadError && error.reason === "missing") return null;
				throw new Error(
					error instanceof SecretReadError && error.reason === "blocked"
						? "the Slack app's tokens cannot be read without macOS asking for your login password; enter them again on the bot's page"
						: "the Slack app's tokens could not be read on this computer; enter them again on the bot's page",
				);
			}
		};
		const botToken = read("bot");
		if (!botToken) return null;
		return { botToken, appToken: read("app"), signingSecret: read("signing") };
	}

	#file(): string {
		return join(this.#options.dir, "bot-connectors.json");
	}

	#load(): Stored[] {
		try {
			const parsed = JSON.parse(readFileSync(this.#file(), "utf8")) as { slack?: unknown };
			if (!Array.isArray(parsed.slack)) return [];
			return parsed.slack.filter(
				(app): app is Stored =>
					typeof app?.id === "string" &&
					/^slack-[0-9a-f]{16}$/.test(app.id) &&
					typeof app.team === "string" &&
					typeof app.teamId === "string" &&
					typeof app.botUserId === "string",
			);
		} catch {
			return [];
		}
	}

	#write(): void {
		writeFileAtomicSync(this.#file(), JSON.stringify({ version: 1, slack: this.#apps }, null, 2), { mode: 0o600 });
		this.#options.onChange?.(this.state());
	}
}

function key(id: string, kind: Secret): string {
	return `${id}-${kind}`;
}
