/**
 * A bot's connectors (orca-bots-connectors; the owner's decision of 26 Nov 2026: Orca's Slack, GitHub, Linear and Google
 * connectors on a local route, with the person's own credentials, never Orca Cloud or Composio). A connector is one of
 * the bot's routines that wakes its home chat (`ScheduleEvent` `slack`, `github` with `ask`, `linear`, `google`); the
 * core makes it from the bot's page (`BotsRequest` `connect`) and the bot answers with `ompdesk_bot reply`.
 *
 * What a connector needs that is not a routine lives in main (`src/main/connector-accounts.ts`): a Slack app's bot
 * token, app-level token and signing secret, a Google sign-in's client secret and refresh token, each encrypted by the
 * OS keystore and never sent back to a window, an agent or a log. Linear uses a Settings › Trackers account; GitHub
 * the person's own `gh`.
 */
import type { ConnectorAsker, Schedule, ScheduleEvent, SchedulesState } from "./schedules";

export const BOT_CONNECTOR_SERVICES = ["slack", "github", "linear", "google"] as const;
export type BotConnectorService = (typeof BOT_CONNECTOR_SERVICES)[number];

/** A Slack app the owner made for a bot and installed in a workspace. */
export interface SlackApp {
	id: string;
	/** The workspace's name, as Slack's `auth.test` said it. */
	team: string;
	teamId: string;
	/** The app's bot user (`<@U…>` mentions it). */
	botUserId: string;
	/** An app-level token is kept: its events come over Socket Mode, with no public address. */
	socketMode: boolean;
	/** A signing secret is kept: its events may also come to `POST /hooks/<id>`. */
	signingSecret: boolean;
	/** A kept token cannot be read this run without macOS asking for the login password: enter it again. */
	needsReentry: boolean;
}

/**
 * A Google account the owner signed in to for bots, through their own Google app (a Desktop OAuth client made in
 * Google Cloud; Orca `google-setup.md`): the calendar's events and Gmail are read with it.
 */
export interface GoogleAccount {
	id: string;
	email: string;
	/** A kept token cannot be read this run without macOS asking for the login password: sign in again. */
	needsReentry: boolean;
}

export interface BotConnectorsState {
	slack: SlackApp[];
	google: GoogleAccount[];
	/** The account that the host just imported. Absent on cancel and on an ordinary list. */
	importedId?: string;
}

/** An email routine's account that is a Google sign-in for bots (`google:<email>`): Gmail over IMAP with OAuth. */
export const GMAIL_ACCOUNT = "google:";

export type BotConnectorsRequest =
	| { action: "list" }
	| { action: "importSlack"; mode: "socket" | "url"; id?: string }
	| { action: "importLinear" }
	| { action: "removeSlack"; id: string }
	/** Sign in with a desktop client chosen in the host's native picker, or with the saved client. */
	| { action: "signInGoogle"; id?: string }
	/** Ends the sign-in under way. */
	| { action: "cancelGoogle" }
	| { action: "removeGoogle"; id: string };

export interface BotConnectorsApi {
	command(request: BotConnectorsRequest): Promise<BotConnectorsState>;
}

/** The handle a bot is asked by in GitHub and Linear text (`bot:<handle>`): its name, lowercase, a-z 0-9 and `-`. */
export function botHandle(name: string): string {
	const handle = name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return handle || "bot";
}

/** Who may ask through a connector: `*` is anyone. */
export const ANYONE = "*";

/** A connector of a bot, as its routine holds it. */
export type BotConnector =
	| { service: "slack"; schedule: Schedule; account: string; from: string[] }
	| { service: "github"; schedule: Schedule; repo: string; handle: string; from: string[] }
	| { service: "linear"; schedule: Schedule; account: string; handle: string; from: string[] }
	| { service: "google"; schedule: Schedule; account: string; leadMinutes: number }
	| { service: "gmail"; schedule: Schedule; account: string; from?: string };

/** The connector a schedule is, by its event; null for any other schedule. */
export function connectorOf(schedule: Schedule): BotConnector | null {
	const frequency = schedule.frequency;
	if (frequency.kind !== "event") return null;
	const event: ScheduleEvent = frequency.event;
	switch (event.source) {
		case "slack":
			return { service: "slack", schedule, account: event.account, from: event.from };
		case "github":
			return event.ask
				? { service: "github", schedule, repo: event.repo, handle: event.ask, from: event.from ?? [ANYONE] }
				: null;
		case "linear":
			return { service: "linear", schedule, account: event.account, handle: event.handle, from: event.from };
		case "google":
			return { service: "google", schedule, account: event.account, leadMinutes: event.leadMinutes };
		case "email":
			return event.account.startsWith(GMAIL_ACCOUNT)
				? {
						service: "gmail",
						schedule,
						account: event.account.slice(GMAIL_ACCOUNT.length),
						...(event.from ? { from: event.from } : {}),
					}
				: null;
		default:
			return null;
	}
}

/** Someone waiting for the owner to let them ask through one of the bot's connectors. */
export interface WaitingAsker {
	connector: Extract<BotConnector, { from: string[] }>;
	asker: ConnectorAsker;
}

/**
 * The access asks of these schedules still waiting on the owner (Orca's Request access, `bot-access-request.ts`): not
 * declined, and not let in since (a person the connector now lists, or a connector open to anyone), newest first.
 */
export function waitingAskers(schedules: readonly Schedule[], asking: SchedulesState["asking"]): WaitingAsker[] {
	const waiting: WaitingAsker[] = [];
	for (const schedule of schedules) {
		const connector = connectorOf(schedule);
		if (!connector || connector.service === "google" || connector.service === "gmail") continue;
		const from = connector.from.map(person => person.trim().toLowerCase());
		if (from.includes(ANYONE)) continue;
		for (const asker of asking?.[schedule.id] ?? []) {
			if (asker.declined || from.includes(asker.person.toLowerCase())) continue;
			waiting.push({ connector, asker });
		}
	}
	return waiting.toSorted((a, b) => Date.parse(b.asker.at) - Date.parse(a.asker.at));
}

/**
 * What a bot's GitHub connector reads: new issues and pull requests, and comments on either (a pull request's
 * conversation included), each asking only when it says `bot:<handle>` (Orca `bot-github-copy.ts:58`).
 */
export const GITHUB_ASK_EVENTS = ["issue", "pull_request", "comment"] as const;

/**
 * The manifest of a bot's Slack app (paste it at api.slack.com/apps › Create New App › From a manifest): a bot user
 * named after the bot that hears mentions and direct messages and posts replies, over Socket Mode. To have Slack call
 * a request URL instead (the person's own tunnel to this computer's `/hooks/<id>`), they turn Socket Mode off and set
 * that URL under Event Subscriptions after the connector is saved, once its signing secret lets the URL check through.
 */
export function slackManifest(name: string): string {
	const display = name.trim().slice(0, 35) || "Bot";
	const manifest = {
		display_information: {
			name: display,
			description: `${display}, a bot that runs on its owner's computer in OMPdesk.`.slice(0, 140),
		},
		features: {
			app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
			bot_user: { display_name: display, always_online: true },
		},
		oauth_config: {
			scopes: { bot: ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write"] },
		},
		settings: {
			event_subscriptions: { bot_events: ["app_mention", "message.im"] },
			interactivity: { is_enabled: false },
			org_deploy_enabled: false,
			socket_mode_enabled: true,
			token_rotation_enabled: false,
		},
	};
	return JSON.stringify(manifest, null, 2);
}
