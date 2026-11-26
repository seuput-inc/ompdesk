/**
 * A bot's connectors (orca-bots-connectors; Orca's `settings/bots/BotConnectorsSection.tsx:89-185`,
 * `BotConnectorRow.tsx:133-194`, `AddConnectorDialog.tsx:17-76`, `apps/bot-app-catalog.ts:84-93`, `ConnectorTryIt.tsx`,
 * `BotHowToAsk.tsx` and the per-service setup flows under `bots/{slack,github,linear}/`, `google-setup.md`), on a
 * local route: the person's own Slack app, `gh`, Linear key and Google app, never Orca Cloud or Composio.
 *
 * - `BotConnectorsSection` (FS79): the bot page's Connectors, one row per connector (its routine, `connectorOf`) with
 *   how to ask it and who may; Add opens the dialog.
 * - `ConnectorDialog` (C2-45 "Add to <bot>", the setup sheets, FK-B33 who can ask, FK-B54 Try it): pick a service,
 *   then its setup in place (one dialog, never a second over it); saving makes or changes the routine
 *   (`BotsRequest` `connect`) and ends on the Try it line.
 * - `ConnectorOfferCard` (FM64): the card a bot's `ompdesk_bot offer_connector` leaves in its chat, whose button opens the
 *   dialog on that service.
 */
import { CalendarDays, GitPullRequest, Hash, ListChecks, Mail, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
	ANYONE,
	BOT_CONNECTOR_SERVICES,
	type BotConnector,
	type BotConnectorService,
	type BotConnectorsState,
	botHandle,
	connectorOf,
	GITHUB_ASK_EVENTS,
	GMAIL_ACCOUNT,
	slackManifest,
} from "../../../shared/bot-connectors";
import type { Bot } from "../../../shared/bots";
import type { ScheduleEvent } from "../../../shared/schedules";
import type { TrackersState } from "../../../shared/trackers";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { webhookUrl } from "../../lib/schedule-text";
import { useBotsStore } from "../../stores/bots";
import { useGithubAuthStore } from "../../stores/github-auth";
import { toast, toastError } from "../../stores/toast";
import {
	Banner,
	Button,
	Card,
	CopyButton,
	EmptyState,
	Input,
	ListRow,
	MenuButton,
	Modal,
	SectionLabel,
	SegmentedChoice,
	Select,
	SwitchField,
	TextArea,
} from "../common";
import { isBotSchedule, useLocalSchedules } from "./bot-automations";

const SLACK_APPS_URL = "https://api.slack.com/apps?new_app=1";
const GOOGLE_CLOUD_URL = "https://console.cloud.google.com/apis/credentials";

const ICONS: Record<BotConnector["service"], ReactNode> = {
	slack: <Hash aria-hidden className="size-4 text-(--sc-text-muted)" />,
	github: <GitPullRequest aria-hidden className="size-4 text-(--sc-text-muted)" />,
	linear: <ListChecks aria-hidden className="size-4 text-(--sc-text-muted)" />,
	google: <CalendarDays aria-hidden className="size-4 text-(--sc-text-muted)" />,
	gmail: <Mail aria-hidden className="size-4 text-(--sc-text-muted)" />,
};

/** The setup a connector is changed in: a bot's Gmail and its calendar share the Google one. */
function setupOf(connector: BotConnector): BotConnectorService {
	return connector.service === "gmail" ? "google" : connector.service;
}

/** Who may ask, as a comma list; `*` alone is anyone. */
function peopleOf(text: string): string[] {
	return [
		...new Set(
			text
				.split(",")
				.map(person => person.trim())
				.filter(Boolean),
		),
	];
}

/** This computer's bots' Slack apps and Google sign-ins, read once per surface (their tokens never come back). */
function useSlackApps(): [BotConnectorsState, (state: BotConnectorsState) => void] {
	const [state, setState] = useState<BotConnectorsState>({ slack: [], google: [] });
	useEffect(() => {
		if (typeof window.omp?.botConnectors?.command !== "function") return;
		let live = true;
		window.omp.botConnectors
			.command({ action: "list" })
			.then(read => {
				if (live) setState(read);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);
	return [state, setState];
}

/** The connector's place in words: the Slack workspace, the repository, the Linear workspace. */
function placeOf(connector: BotConnector, apps: BotConnectorsState, trackers: TrackersState | null): string {
	switch (connector.service) {
		case "slack":
			return apps.slack.find(app => app.id === connector.account)?.team ?? connector.account;
		case "github":
			return connector.repo;
		case "linear":
			return trackers?.accounts.find(account => account.id === connector.account)?.label ?? connector.account;
		case "google":
		case "gmail":
			return connector.account;
	}
}

/** How someone asks the bot through a connector (FK-B54's how-to-ask line). */
export function HowToAsk({ bot, connector }: { bot: Bot; connector: BotConnector }) {
	const t = useT();
	switch (connector.service) {
		case "slack":
			return <>{t("bots.connectors.ask.slack", { name: bot.name })}</>;
		case "github":
			return <>{t("bots.connectors.ask.github", { handle: connector.handle, repo: connector.repo })}</>;
		case "linear":
			return <>{t("bots.connectors.ask.linear", { handle: connector.handle })}</>;
		case "google":
			return <>{t("bots.connectors.ask.google", { name: bot.name, minutes: connector.leadMinutes })}</>;
		case "gmail":
			return <>{t("bots.connectors.ask.gmail", { name: bot.name, email: connector.account })}</>;
	}
}

function whoLabel(t: (key: string, params?: Record<string, number>) => string, connector: BotConnector): string {
	if (connector.service === "google") return "";
	if (connector.service === "gmail") return connector.from ?? "";
	if (connector.from.includes(ANYONE)) return t("bots.connectors.who.anyone");
	return connector.from.length === 1
		? connector.from[0] === "me"
			? t("bots.connectors.who.you")
			: connector.from[0]
		: t("bots.connectors.who.people", { count: connector.from.length });
}

export function BotConnectorsSection({ bot }: { bot: Bot }) {
	const t = useT();
	const schedules = useLocalSchedules();
	const [apps, setApps] = useSlackApps();
	const [trackers, setTrackers] = useState<TrackersState | null>(null);
	const command = useBotsStore(s => s.command);
	const [dialog, setDialog] = useState<{ service?: BotConnectorService; connector?: BotConnector } | null>(null);
	useEffect(() => {
		if (typeof window.omp?.trackers?.command !== "function") return;
		window.omp.trackers
			.command({ action: "state" })
			.then(setTrackers)
			.catch(() => {});
	}, []);
	const connectors = schedules.schedules
		.filter(schedule => isBotSchedule(bot, schedule))
		.flatMap(schedule => connectorOf(schedule) ?? []);
	const add = (
		<Button data-bot-connectors-add icon={<Plus />} onClick={() => setDialog({})} size="sm" variant="ghost">
			{t("bots.connectors.add")}
		</Button>
	);
	return (
		<section className="flex flex-col gap-1" data-bot-connectors>
			<SectionLabel action={connectors.length > 0 ? add : undefined}>{t("bots.connectors.title")}</SectionLabel>
			{connectors.length === 0 ? (
				<EmptyState
					actions={
						<Button data-bot-connectors-add onClick={() => setDialog({})} size="sm" variant="secondary">
							{t("bots.connectors.addFirst")}
						</Button>
					}
					size="row"
					title={t("bots.connectors.empty", { name: bot.name })}
				/>
			) : (
				connectors.map(connector => (
					<ListRow
						actions={
							<MenuButton
								icon={<Trash2 />}
								items={[
									{
										id: "edit",
										label: t("bots.connectors.edit"),
										onSelect: () => setDialog({ service: setupOf(connector), connector }),
									},
									{
										id: "remove",
										label: t("bots.connectors.remove"),
										danger: true,
										onSelect: () =>
											void command({
												action: "disconnect",
												id: bot.id,
												schedule: connector.schedule.id,
											}).catch((error: unknown) =>
												toastError({ title: t("bots.connectors.saveFailed"), error }),
											),
									},
								]}
								label={t("bots.connectors.menu")}
								size="sm"
								variant="ghost"
							/>
						}
						rowProps={{ "data-bot-connector": connector.service }}
						description={<HowToAsk bot={bot} connector={connector} />}
						descriptionLines={2}
						key={connector.schedule.id}
						leading={ICONS[connector.service]}
						meta={connector.schedule.enabled ? whoLabel(t, connector) : t("bots.connectors.off")}
						onClick={() => setDialog({ service: setupOf(connector), connector })}
						size="sm"
						title={`${t(`bots.connectors.service.${connector.service}`)} · ${placeOf(connector, apps, trackers)}`}
					/>
				))
			)}
			{dialog && (
				<ConnectorDialog
					apps={apps}
					bot={bot}
					connector={dialog.connector}
					onApps={setApps}
					onClose={() => setDialog(null)}
					onTrackers={setTrackers}
					service={dialog.service}
					trackers={trackers}
				/>
			)}
		</section>
	);
}

/** Where the setup is: picking the service, its form, or done with its Try it line. */
type Step = { kind: "pick" } | { kind: "setup"; service: BotConnectorService } | { kind: "done"; schedule: string };

export function ConnectorDialog({
	bot,
	service,
	connector,
	apps,
	trackers,
	onApps,
	onTrackers,
	onClose,
}: {
	bot: Bot;
	service?: BotConnectorService;
	connector?: BotConnector;
	apps: BotConnectorsState;
	trackers: TrackersState | null;
	onApps: (state: BotConnectorsState) => void;
	onTrackers: (state: TrackersState) => void;
	onClose: () => void;
}) {
	const t = useT();
	const [step, setStep] = useState<Step>(service ? { kind: "setup", service } : { kind: "pick" });
	const schedules = useLocalSchedules();
	const done =
		step.kind === "done"
			? schedules.schedules.flatMap(schedule =>
					schedule.id === step.schedule ? (connectorOf(schedule) ?? []) : [],
				)[0]
			: undefined;
	return (
		<Modal
			description={step.kind === "pick" ? t("bots.connectors.pickHint") : undefined}
			footer={
				step.kind === "done" ? (
					<Button onClick={onClose} variant="primary">
						{t("bots.connectors.done")}
					</Button>
				) : undefined
			}
			onClose={onClose}
			open
			title={
				step.kind === "pick"
					? t("bots.connectors.addTitle", { name: bot.name })
					: step.kind === "setup"
						? t(`bots.connectors.setup.${step.service}`)
						: t("bots.connectors.tryIt")
			}
		>
			{!bot.home && <Banner variant="warning">{t("bots.connectors.needsHome", { name: bot.name })}</Banner>}
			{step.kind === "pick" && (
				<div className="flex flex-col gap-1" data-connector-catalog>
					{BOT_CONNECTOR_SERVICES.map(service => (
						<ListRow
							rowProps={{ "data-connector-pick": service }}
							description={t(`bots.connectors.catalog.${service}`)}
							key={service}
							leading={ICONS[service]}
							onClick={() => setStep({ kind: "setup", service })}
							title={t(`bots.connectors.service.${service}`)}
						/>
					))}
				</div>
			)}
			{step.kind === "setup" && step.service === "slack" && (
				<SlackSetup
					apps={apps}
					bot={bot}
					connector={connector?.service === "slack" ? connector : undefined}
					onApps={onApps}
					onCancel={onClose}
					onDone={schedule => setStep({ kind: "done", schedule })}
				/>
			)}
			{step.kind === "setup" && step.service === "github" && (
				<GithubSetup
					bot={bot}
					connector={connector?.service === "github" ? connector : undefined}
					onCancel={onClose}
					onDone={schedule => setStep({ kind: "done", schedule })}
				/>
			)}
			{step.kind === "setup" && step.service === "linear" && (
				<LinearSetup
					bot={bot}
					connector={connector?.service === "linear" ? connector : undefined}
					onCancel={onClose}
					onDone={schedule => setStep({ kind: "done", schedule })}
					onTrackers={onTrackers}
					trackers={trackers}
				/>
			)}
			{step.kind === "setup" && step.service === "google" && (
				<GoogleSetup
					apps={apps}
					bot={bot}
					connector={connector?.service === "google" || connector?.service === "gmail" ? connector : undefined}
					onApps={onApps}
					onCancel={onClose}
					onDone={schedule => setStep({ kind: "done", schedule })}
				/>
			)}
			{step.kind === "done" && done && <TryIt bot={bot} connector={done} />}
		</Modal>
	);
}

/** FK-B54: how to try the connector just made, and for a Slack app on a request URL, the path to paste. */
function TryIt({ bot, connector }: { bot: Bot; connector: BotConnector }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-3" data-connector-try={connector.service}>
			<Card padding="md">
				<p className="text-sc-sm">
					<HowToAsk bot={bot} connector={connector} />
				</p>
			</Card>
			<p className="text-sc-xs text-(--sc-text-muted)">{t(`bots.connectors.answers.${connector.service}`)}</p>
			{connector.service === "slack" && (
				<div className="flex min-w-0 items-center gap-2 text-sc-xs" data-connector-hook>
					<span className="shrink-0 text-(--sc-text-muted)">{t("bots.connectors.slack.hookPath")}</span>
					<code className="min-w-0 flex-1 truncate font-mono">/hooks/{connector.schedule.id}</code>
					<CopyButton label={t("bots.connectors.slack.copyHook")} text={webhookUrl(connector.schedule.id)} />
				</div>
			)}
		</div>
	);
}

/** Who may ask through a connector (FK-B33): the people listed, or anyone who can write there. */
function WhoCanAsk({
	people,
	anyone,
	hint,
	onPeople,
	onAnyone,
}: {
	people: string;
	anyone: boolean;
	hint: string;
	onPeople: (text: string) => void;
	onAnyone: (on: boolean) => void;
}) {
	const t = useT();
	return (
		<div className="flex flex-col gap-2">
			<SwitchField
				checked={anyone}
				description={t("bots.connectors.who.anyoneHint")}
				label={t("bots.connectors.who.anyoneSwitch")}
				onCheckedChange={onAnyone}
			/>
			{!anyone && (
				<Input
					hint={hint}
					label={t("bots.connectors.who.title")}
					mono
					onChange={event => onPeople(event.target.value)}
					value={people}
				/>
			)}
		</div>
	);
}

/** Saves the routine (new, or `connector`'s in place) and answers its schedule id. */
async function connect(bot: Bot, on: ScheduleEvent, connector?: BotConnector): Promise<string | null> {
	const before = new Set(
		(await window.omp.schedules.command({ action: "get" })).schedules.map(schedule => schedule.id),
	);
	await useBotsStore.getState().command({
		action: "connect",
		id: bot.id,
		on,
		...(connector ? { schedule: connector.schedule.id } : {}),
	});
	if (connector) return connector.schedule.id;
	const after = await window.omp.schedules.command({ action: "get" });
	return after.schedules.find(schedule => !before.has(schedule.id))?.id ?? null;
}

function SetupFooter({
	saving,
	disabled,
	onCancel,
	onSave,
}: {
	saving: boolean;
	disabled: boolean;
	onCancel: () => void;
	onSave: () => void;
}) {
	const t = useT();
	return (
		<div className="flex justify-end gap-2">
			<Button onClick={onCancel} variant="ghost">
				{t("bots.connectors.cancel")}
			</Button>
			<Button disabled={disabled} loading={saving} onClick={onSave} variant="primary">
				{t("bots.connectors.save")}
			</Button>
		</div>
	);
}

function useSave(onDone: (schedule: string) => void) {
	const t = useT();
	const [saving, setSaving] = useState(false);
	const run = (work: () => Promise<string | null>) => {
		setSaving(true);
		work()
			.then(schedule => {
				setSaving(false);
				if (schedule) onDone(schedule);
			})
			.catch((error: unknown) => {
				setSaving(false);
				toastError({ title: t("bots.connectors.saveFailed"), error });
			});
	};
	return [saving, run] as const;
}

function SlackSetup({
	bot,
	connector,
	apps,
	onApps,
	onCancel,
	onDone,
}: {
	bot: Bot;
	connector?: Extract<BotConnector, { service: "slack" }>;
	apps: BotConnectorsState;
	onApps: (state: BotConnectorsState) => void;
	onCancel: () => void;
	onDone: (schedule: string) => void;
}) {
	const t = useT();
	const kept = connector ? apps.slack.find(app => app.id === connector.account) : undefined;
	const [mode, setMode] = useState<"socket" | "url">(
		kept && !kept.socketMode && kept.signingSecret ? "url" : "socket",
	);
	const [botToken, setBotToken] = useState("");
	const [appToken, setAppToken] = useState("");
	const [signingSecret, setSigningSecret] = useState("");
	const [anyone, setAnyone] = useState(connector?.from.includes(ANYONE) ?? false);
	const [people, setPeople] = useState(connector?.from.filter(person => person !== ANYONE).join(", ") ?? "");
	const [saving, save] = useSave(onDone);
	const manifest = slackManifest(bot.name);
	const from = anyone ? [ANYONE] : peopleOf(people);
	const ready =
		Boolean(bot.home) &&
		from.length > 0 &&
		(kept ? true : botToken.trim() !== "") &&
		(mode === "socket"
			? Boolean(kept?.socketMode) || appToken.trim() !== ""
			: Boolean(kept?.signingSecret) || signingSecret.trim() !== "");
	const keptHint = kept ? t("bots.connectors.slack.kept") : undefined;
	return (
		<div className="flex flex-col gap-4" data-connector-setup="slack">
			<SegmentedChoice
				aria-label={t("bots.connectors.slack.mode")}
				onChange={setMode}
				optionAttr="data-slack-mode"
				options={[
					{ value: "socket", label: t("bots.connectors.slack.socket") },
					{ value: "url", label: t("bots.connectors.slack.url") },
				]}
				value={mode}
			/>
			<p className="text-sc-xs text-(--sc-text-muted)">
				{mode === "socket" ? t("bots.connectors.slack.socketHint") : t("bots.connectors.slack.urlHint")}
			</p>
			<section className="flex flex-col gap-2">
				<SectionLabel as="h4">{t("bots.connectors.slack.step1")}</SectionLabel>
				<Card padding="sm" surface="code">
					<pre className="max-h-40 overflow-auto font-mono text-sc-xs" data-slack-manifest>
						{manifest}
					</pre>
				</Card>
				<div className="flex gap-2">
					<CopyButton label={t("bots.connectors.slack.copyManifest")} text={manifest} />
					<Button onClick={() => openExternal(SLACK_APPS_URL)} size="sm" variant="secondary">
						{t("bots.connectors.slack.open")}
					</Button>
				</div>
			</section>
			<section className="flex flex-col gap-2">
				<SectionLabel as="h4">{t("bots.connectors.slack.step2")}</SectionLabel>
				<Input
					autoComplete="off"
					hint={keptHint}
					label={t("bots.connectors.slack.botToken")}
					mono
					onChange={event => setBotToken(event.target.value)}
					placeholder="xoxb-…"
					type="password"
					value={botToken}
				/>
				{mode === "socket" ? (
					<Input
						autoComplete="off"
						hint={kept?.socketMode ? keptHint : t("bots.connectors.slack.appTokenHint")}
						label={t("bots.connectors.slack.appToken")}
						mono
						onChange={event => setAppToken(event.target.value)}
						placeholder="xapp-…"
						type="password"
						value={appToken}
					/>
				) : (
					<Input
						autoComplete="off"
						hint={kept?.signingSecret ? keptHint : t("bots.connectors.slack.signingHint")}
						label={t("bots.connectors.slack.signingSecret")}
						mono
						onChange={event => setSigningSecret(event.target.value)}
						type="password"
						value={signingSecret}
					/>
				)}
			</section>
			<section className="flex flex-col gap-2">
				<SectionLabel as="h4">{t("bots.connectors.slack.step3")}</SectionLabel>
				<WhoCanAsk
					anyone={anyone}
					hint={t("bots.connectors.who.slackHint")}
					onAnyone={setAnyone}
					onPeople={setPeople}
					people={people}
				/>
			</section>
			<SetupFooter
				disabled={!ready}
				onCancel={onCancel}
				onSave={() =>
					save(async () => {
						const ids = new Set(apps.slack.map(app => app.id));
						const state = await window.omp.botConnectors.command({
							action: "saveSlack",
							...(kept ? { id: kept.id } : {}),
							...(botToken.trim() ? { botToken: botToken.trim() } : {}),
							...(mode === "socket" && appToken.trim() ? { appToken: appToken.trim() } : {}),
							...(mode === "url" && signingSecret.trim() ? { signingSecret: signingSecret.trim() } : {}),
						});
						onApps(state);
						const app = kept ?? state.slack.find(saved => !ids.has(saved.id)) ?? state.slack.at(-1);
						if (!app) return null;
						const schedule = await connect(bot, { source: "slack", account: app.id, from }, connector);
						toast({
							variant: "success",
							message: t("bots.connectors.saved", { service: t("bots.connectors.service.slack") }),
						});
						return schedule;
					})
				}
				saving={saving}
			/>
		</div>
	);
}

function GithubSetup({
	bot,
	connector,
	onCancel,
	onDone,
}: {
	bot: Bot;
	connector?: Extract<BotConnector, { service: "github" }>;
	onCancel: () => void;
	onDone: (schedule: string) => void;
}) {
	const t = useT();
	const login = useGithubAuthStore(s => s.state.status?.login ?? null);
	const refresh = useGithubAuthStore(s => s.refresh);
	useEffect(() => void refresh(), [refresh]);
	const [repo, setRepo] = useState(connector?.repo ?? "");
	const [anyone, setAnyone] = useState(connector?.from.includes(ANYONE) ?? false);
	const [people, setPeople] = useState(connector?.from.filter(person => person !== ANYONE).join(", ") ?? "");
	useEffect(() => {
		if (!connector && login) setPeople(current => current || login);
	}, [connector, login]);
	const [saving, save] = useSave(onDone);
	const handle = connector?.handle ?? botHandle(bot.name);
	const from = peopleOf(people);
	const ready = Boolean(bot.home) && /^[\w.-]+\/[\w.-]+$/.test(repo.trim()) && (anyone || from.length > 0);
	return (
		<div className="flex flex-col gap-4" data-connector-setup="github">
			<Input
				hint={t("bots.connectors.github.repoHint")}
				label={t("bots.connectors.github.repo")}
				mono
				onChange={event => setRepo(event.target.value)}
				placeholder="owner/name"
				value={repo}
			/>
			<WhoCanAsk
				anyone={anyone}
				hint={t("bots.connectors.who.githubHint")}
				onAnyone={setAnyone}
				onPeople={setPeople}
				people={people}
			/>
			<p className="text-sc-xs text-(--sc-text-muted)">
				{t("bots.connectors.github.asYou", { login: login ?? "—", handle })}
			</p>
			<SetupFooter
				disabled={!ready}
				onCancel={onCancel}
				onSave={() =>
					save(async () => {
						const schedule = await connect(
							bot,
							{
								source: "github",
								repo: repo.trim(),
								events: [...GITHUB_ASK_EVENTS],
								ask: handle,
								...(anyone ? {} : { from }),
							},
							connector,
						);
						toast({
							variant: "success",
							message: t("bots.connectors.saved", { service: t("bots.connectors.service.github") }),
						});
						return schedule;
					})
				}
				saving={saving}
			/>
		</div>
	);
}

function LinearSetup({
	bot,
	connector,
	trackers,
	onTrackers,
	onCancel,
	onDone,
}: {
	bot: Bot;
	connector?: Extract<BotConnector, { service: "linear" }>;
	trackers: TrackersState | null;
	onTrackers: (state: TrackersState) => void;
	onCancel: () => void;
	onDone: (schedule: string) => void;
}) {
	const t = useT();
	const accounts = (trackers?.accounts ?? []).filter(account => account.provider === "linear");
	const [account, setAccount] = useState(connector?.account ?? accounts[0]?.id ?? "");
	const [apiKey, setApiKey] = useState("");
	const [anyone, setAnyone] = useState(connector?.from.includes(ANYONE) ?? false);
	const [people, setPeople] = useState(connector?.from.filter(person => person !== ANYONE).join(", ") ?? "me");
	const [saving, save] = useSave(onDone);
	const handle = connector?.handle ?? botHandle(bot.name);
	const from = anyone ? [ANYONE] : peopleOf(people);
	const ready = Boolean(bot.home) && (account !== "" || apiKey.trim() !== "") && from.length > 0;
	return (
		<div className="flex flex-col gap-4" data-connector-setup="linear">
			{accounts.length > 0 ? (
				<Select
					label={t("bots.connectors.linear.account")}
					onChange={event => setAccount(event.target.value)}
					options={accounts.map(known => ({ value: known.id, label: known.label }))}
					value={account}
				/>
			) : (
				<Input
					autoComplete="off"
					hint={t("bots.connectors.linear.keyHint")}
					label={t("bots.connectors.linear.key")}
					mono
					onChange={event => setApiKey(event.target.value)}
					placeholder="lin_api_…"
					type="password"
					value={apiKey}
				/>
			)}
			<WhoCanAsk
				anyone={anyone}
				hint={t("bots.connectors.who.linearHint")}
				onAnyone={setAnyone}
				onPeople={setPeople}
				people={people}
			/>
			<p className="text-sc-xs text-(--sc-text-muted)">{t("bots.connectors.linear.asYou", { handle })}</p>
			<SetupFooter
				disabled={!ready}
				onCancel={onCancel}
				onSave={() =>
					save(async () => {
						let id = account;
						if (!id) {
							// The workspace is kept with Agents › GitHub's Linear source: one key for both.
							const state = await window.omp.trackers.accounts({
								action: "connect",
								draft: { provider: "linear", apiKey: apiKey.trim() },
							});
							onTrackers(state);
							id = state.selected.linear ?? "";
							if (!id || id === "all") return null;
						}
						const schedule = await connect(bot, { source: "linear", account: id, handle, from }, connector);
						toast({
							variant: "success",
							message: t("bots.connectors.saved", { service: t("bots.connectors.service.linear") }),
						});
						return schedule;
					})
				}
				saving={saving}
			/>
		</div>
	);
}

/**
 * Google (Orca `google-setup.md`, `google-scopes.ts:24-68`, `google-trigger-match.ts:173-199`): the person's own
 * Desktop OAuth client signs in from this computer's browser; the bot is woken before calendar events, by new Gmail,
 * or both (each its own routine). Editing one changes only that one.
 */
function GoogleSetup({
	bot,
	connector,
	apps,
	onApps,
	onCancel,
	onDone,
}: {
	bot: Bot;
	connector?: Extract<BotConnector, { service: "google" | "gmail" }>;
	apps: BotConnectorsState;
	onApps: (state: BotConnectorsState) => void;
	onCancel: () => void;
	onDone: (schedule: string) => void;
}) {
	const t = useT();
	const [account, setAccount] = useState(connector?.account ?? apps.google[0]?.email ?? "");
	const [clientFile, setClientFile] = useState("");
	const [signingIn, setSigningIn] = useState(false);
	const [calendar, setCalendar] = useState(connector ? connector.service === "google" : true);
	const [lead, setLead] = useState(String(connector?.service === "google" ? connector.leadMinutes : 10));
	const [gmail, setGmail] = useState(connector?.service === "gmail");
	const [gmailFrom, setGmailFrom] = useState(connector?.service === "gmail" ? (connector.from ?? "") : "");
	const [saving, save] = useSave(onDone);
	const kept = apps.google.find(known => known.email === account);
	const minutes = Number.parseInt(lead, 10);
	const ready =
		Boolean(bot.home) &&
		Boolean(kept) &&
		!kept?.needsReentry &&
		(calendar || gmail) &&
		(!calendar || (minutes >= 0 && minutes <= 1440));
	const signIn = () => {
		setSigningIn(true);
		const known = new Set(apps.google.map(item => item.email));
		window.omp.botConnectors
			.command({
				action: "signInGoogle",
				...(clientFile.trim() ? { clientFile: clientFile.trim() } : kept ? { id: kept.id } : {}),
			})
			.then(state => {
				setSigningIn(false);
				onApps(state);
				setClientFile("");
				const signed = state.google.find(item => !known.has(item.email));
				if (signed) setAccount(signed.email);
			})
			.catch((error: unknown) => {
				setSigningIn(false);
				toastError({ title: t("bots.connectors.google.signInFailed"), error });
			});
	};
	const cancelSignIn = () =>
		void window.omp.botConnectors.command({ action: "cancelGoogle" }).catch(() => {
			// The sign-in's own answer says how it ended.
		});
	// A sign-in still waiting in the browser when the sheet closes ends with it (after one that ended, main has none).
	useEffect(() => {
		if (!signingIn) return;
		return () =>
			void window.omp.botConnectors.command({ action: "cancelGoogle" }).catch(() => {
				// Nothing was waiting.
			});
	}, [signingIn]);
	return (
		<div className="flex flex-col gap-4" data-connector-setup="google">
			{apps.google.length > 0 && (
				<Select
					label={t("bots.connectors.google.account")}
					onChange={event => setAccount(event.target.value)}
					options={[
						...apps.google.map(known => ({ value: known.email, label: known.email })),
						{ value: "", label: t("bots.connectors.google.another") },
					]}
					value={account}
				/>
			)}
			{(!kept || kept.needsReentry) && (
				<>
					{kept?.needsReentry && <Banner variant="warning">{t("bots.connectors.google.reentry")}</Banner>}
					{!kept && (
						<section className="flex flex-col gap-2">
							<SectionLabel as="h4">{t("bots.connectors.google.step1")}</SectionLabel>
							<p className="text-sc-xs text-(--sc-text-muted)">{t("bots.connectors.google.step1Hint")}</p>
							<div className="flex gap-2">
								<Button onClick={() => openExternal(GOOGLE_CLOUD_URL)} size="sm" variant="secondary">
									{t("bots.connectors.google.open")}
								</Button>
							</div>
							<TextArea
								autoComplete="off"
								hint={t("bots.connectors.google.clientFileHint")}
								label={t("bots.connectors.google.clientFile")}
								mono
								onChange={event => setClientFile(event.target.value)}
								placeholder='{"installed":{"client_id":"….apps.googleusercontent.com", …}}'
								rows={3}
								spellCheck={false}
								value={clientFile}
							/>
						</section>
					)}
					<section className="flex flex-col gap-2">
						<SectionLabel as="h4">{t("bots.connectors.google.step2")}</SectionLabel>
						<p className="text-sc-xs text-(--sc-text-muted)">
							{signingIn ? t("bots.connectors.google.waiting") : t("bots.connectors.google.signInHint")}
						</p>
						<div className="flex gap-2">
							<Button
								disabled={!kept && clientFile.trim() === ""}
								loading={signingIn}
								onClick={signIn}
								size="sm"
								variant="primary"
							>
								{t("bots.connectors.google.signIn")}
							</Button>
							{signingIn && (
								<Button onClick={cancelSignIn} size="sm" variant="ghost">
									{t("bots.connectors.cancel")}
								</Button>
							)}
						</div>
					</section>
				</>
			)}
			{kept && !kept.needsReentry && (
				<section className="flex flex-col gap-2">
					<SectionLabel as="h4">{t("bots.connectors.google.step3", { name: bot.name })}</SectionLabel>
					{connector?.service !== "gmail" && (
						<>
							{!connector && (
								<SwitchField
									checked={calendar}
									description={t("bots.connectors.google.calendarHint")}
									label={t("bots.connectors.google.calendar")}
									onCheckedChange={setCalendar}
								/>
							)}
							{calendar && (
								<Input
									inputMode="numeric"
									label={t("bots.connectors.google.lead")}
									max={1440}
									min={0}
									onChange={event => setLead(event.target.value)}
									type="number"
									value={lead}
								/>
							)}
						</>
					)}
					{connector?.service !== "google" && (
						<>
							{!connector && (
								<SwitchField
									checked={gmail}
									description={t("bots.connectors.google.gmailHint")}
									label={t("bots.connectors.google.gmail")}
									onCheckedChange={setGmail}
								/>
							)}
							{gmail && (
								<Input
									hint={t("bots.connectors.google.gmailFromHint")}
									label={t("bots.connectors.google.gmailFrom")}
									onChange={event => setGmailFrom(event.target.value)}
									value={gmailFrom}
								/>
							)}
						</>
					)}
				</section>
			)}
			<SetupFooter
				disabled={!ready}
				onCancel={onCancel}
				onSave={() =>
					save(async () => {
						let first: string | null = null;
						if (calendar)
							first = await connect(
								bot,
								{ source: "google", account, leadMinutes: minutes },
								connector?.service === "google" ? connector : undefined,
							);
						if (gmail) {
							const made = await connect(
								bot,
								{
									source: "email",
									account: `${GMAIL_ACCOUNT}${account}`,
									...(gmailFrom.trim() ? { from: gmailFrom.trim() } : {}),
								},
								connector?.service === "gmail" ? connector : undefined,
							);
							first ??= made;
						}
						toast({
							variant: "success",
							message: t("bots.connectors.saved", { service: t("bots.connectors.service.google") }),
						});
						return first;
					})
				}
				saving={saving}
			/>
		</div>
	);
}

/**
 * FM64: the card a bot's `ompdesk_bot {"action":"offer_connector","service":…}` leaves in its chat; its button opens the
 * connector's setup for that bot. Shown only in the bot's own chat on this computer, where the bot is known.
 */
export function ConnectorOfferCard({ bot, service }: { bot: Bot; service: BotConnectorService }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [apps, setApps] = useSlackApps();
	const [trackers, setTrackers] = useState<TrackersState | null>(null);
	useEffect(() => {
		if (!open || typeof window.omp?.trackers?.command !== "function") return;
		window.omp.trackers
			.command({ action: "state" })
			.then(setTrackers)
			.catch(() => {});
	}, [open]);
	return (
		<Card className="flex items-center gap-3" data-connector-offer={service} padding="md">
			{ICONS[service]}
			<div className="flex min-w-0 flex-1 flex-col">
				<span className="text-sc-sm font-medium">{t("bots.connectors.offer.title")}</span>
				<span className="text-sc-xs text-(--sc-text-muted)">{t(`bots.connectors.catalog.${service}`)}</span>
			</div>
			<Button onClick={() => setOpen(true)} size="sm" variant="primary">
				{t("bots.connectors.offer.connect", { service: t(`bots.connectors.service.${service}`) })}
			</Button>
			{open && (
				<ConnectorDialog
					apps={apps}
					bot={bot}
					onApps={setApps}
					onClose={() => setOpen(false)}
					onTrackers={setTrackers}
					service={service}
					trackers={trackers}
				/>
			)}
		</Card>
	);
}
