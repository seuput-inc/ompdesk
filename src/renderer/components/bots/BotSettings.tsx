/**
 * A bot's settings (Orca's `settings-view/BotSettingsView.tsx` and `BotSettingsRoot.tsx:225-380`): one view the bot
 * page's Settings tab and Settings › Bots both show (FK-B49), with drill-in pages for its soul, its memory and who can
 * ask it. Escape on a page goes back.
 *
 * - Root: its name; Agent (model, routines run without asking, where it runs and its
 *   folder, Active = not paused, with the paused banner's words: FK-B23, B24, B25); Schedule (Look around, Memory
 *   upkeep, each with its time); Items (stale after); Soul and memory; Access (who can ask, its skills); Notifications
 *   (needs permission, task complete, couldn't finish: FK-B26, FS77); Delete bot (its folder stays; its routines go,
 *   FK-B50).
 * - Soul and Memory (`BotSoulEditor.tsx`, `BotFileChangedNotice.tsx`, FK-B21, FS72, FS73, FK-B22): read or edit the
 *   file; saved on Save or ⌘S; a file changed on disk under an edit asks Keep mine or Use theirs; Memory lists its
 *   topic files and the archive.
 * - Who can ask (`BotPairedServersWhoCanAsk.tsx:1-201`, `BotAccessReach.tsx`, FK-B33): the devices paired with this
 *   computer whose agents may message the bot, and the summary of who can ask it.
 *
 * Connectors (Slack, GitHub, Linear, Google) and sharing are not here: connectors come with orca-bots-connectors,
 * sharing is Orca Cloud's.
 */
import { BookOpen, Brain, ChevronLeft, ChevronRight, Copy, Laptop, Smile, Trash2, Users } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { BOT_QUIET_KINDS, type Bot, type BotFile, type BotQuietKind, type BotsRequest } from "../../../shared/bots";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useBotsStore } from "../../stores/bots";
import { useRemoteStore } from "../../stores/remote";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	Banner,
	Button,
	Card,
	Checkbox,
	ConfirmDialog,
	FieldLabel,
	Input,
	ListRow,
	Modal,
	PathText,
	SectionLabel,
	SegmentedChoice,
	Select,
	SwitchField,
	TextEditor,
} from "../common";
import { ModelValueSelect } from "../settings/ModelValueSelect";
import { BotAvatar } from "./BotAvatar";
import { openBotChat } from "./bot-launch";

type Page = "root" | "soul" | "memory" | "access";

const STALE_CHOICES = [0, 3, 7, 14, 30] as const;

export function BotSettings({ bot, onDeleted }: { bot: Bot; onDeleted?: () => void }) {
	const [page, setPage] = useState<Page>("root");
	const back = () => setPage("root");
	if (page === "soul") return <BotFilePage bot={bot} file="SOUL.md" onBack={back} />;
	if (page === "memory") return <BotFilePage bot={bot} file="MEMORY.md" onBack={back} />;
	if (page === "access") return <BotAccessPage bot={bot} onBack={back} />;
	return <BotSettingsRoot bot={bot} onDeleted={onDeleted} onPage={setPage} />;
}

function useUpdate(bot: Bot) {
	const t = useT();
	const command = useBotsStore(s => s.command);
	return (change: Omit<Extract<BotsRequest, { action: "update" }>, "action" | "id">) =>
		void command({ action: "update", id: bot.id, ...change }).catch((error: unknown) =>
			toastError({ title: t("bots.settings.saveFailed"), error }),
		);
}

function BotSettingsRoot({
	bot,
	onDeleted,
	onPage,
}: {
	bot: Bot;
	onDeleted?: () => void;
	onPage: (page: Page) => void;
}) {
	const t = useT();
	const id = useId();
	const update = useUpdate(bot);
	const command = useBotsStore(s => s.command);
	const [name, setName] = useState(bot.name);
	const [deleting, setDeleting] = useState(false);
	const [lookTime, setLookTime] = useState("09:00");
	const [tidyTime, setTidyTime] = useState("03:00");
	useEffect(() => setName(bot.name), [bot.name]);
	const quietToggle = (kind: BotQuietKind, on: boolean) =>
		update({ quiet: on ? bot.quiet.filter(known => known !== kind) : [...bot.quiet, kind] });
	return (
		<div className="flex flex-col gap-5 p-4" data-bot-settings={bot.id}>
			{bot.paused && (
				<Banner
					actions={
						<Button onClick={() => update({ paused: false })} size="sm" variant="secondary">
							{t("bots.settings.resume")}
						</Button>
					}
					data-bot-paused-banner
					variant="warning"
				>
					{t("bots.paused.banner")}
				</Banner>
			)}
			<Card className="flex items-center gap-3" padding="md">
				<BotAvatar bot={bot} size={48} />
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<Input
						aria-label={t("bots.settings.name")}
						controlSize="sm"
						maxLength={80}
						onBlur={() => {
							if (name.trim() && name.trim() !== bot.name) update({ name: name.trim() });
							else setName(bot.name);
						}}
						onChange={event => setName(event.target.value)}
						value={name}
					/>
					{bot.specialty && <p className="truncate text-sc-xs text-(--sc-text-muted)">{bot.specialty}</p>}
				</div>
			</Card>

			<section className="flex flex-col gap-2">
				<SectionLabel>{t("bots.settings.agent")}</SectionLabel>
				<div className="flex flex-col gap-1.5">
					<FieldLabel as="label" htmlFor={`${id}-model`}>
						{t("bots.new.model")}
					</FieldLabel>
					<ModelValueSelect
						id={`${id}-model`}
						kind="model"
						onCommit={value => update({ model: value || null })}
						placeholder={t("bots.new.modelDefault")}
						value={bot.model ?? ""}
					/>
				</div>
				<SwitchField
					checked={bot.autoApprove}
					description={t("bots.settings.autoApproveHint")}
					label={t("bots.settings.autoApprove")}
					onCheckedChange={autoApprove => update({ autoApprove })}
				/>
				<SwitchField
					checked={!bot.paused}
					description={t("bots.settings.activeHint")}
					label={t("bots.settings.active")}
					onCheckedChange={active => update({ paused: !active })}
				/>
				<div className="flex items-center gap-2 text-sc-sm" data-bot-computer>
					<Laptop aria-hidden className="size-4 shrink-0 text-(--sc-text-muted)" />
					<span className="shrink-0">{t("bots.settings.thisComputer")}</span>
					<PathText className="min-w-0 flex-1 text-sc-xs text-(--sc-text-muted)" path={bot.folder} />
					<Button
						icon={<Copy />}
						onClick={() =>
							void navigator.clipboard
								.writeText(bot.folder)
								.then(() => toast({ variant: "success", message: t("bots.menu.pathCopied") }))
								.catch(() => {})
						}
						size="sm"
						variant="ghost"
					>
						{t("bots.menu.copyPath")}
					</Button>
				</div>
			</section>

			<section className="flex flex-col gap-2">
				<SectionLabel>{t("bots.settings.schedule")}</SectionLabel>
				{(
					[
						["lookAround", bot.lookAround, lookTime, setLookTime, "bots.settings.lookAround"],
						["tidy", bot.tidy, tidyTime, setTidyTime, "bots.settings.tidy"],
					] as const
				).map(([key, on, time, setTime, label]) => (
					<div className="flex items-center gap-2" key={key}>
						<SwitchField
							checked={on !== null}
							className="min-w-0 flex-1"
							description={!bot.home ? t("bots.settings.needsHome") : t(`${label}Hint`)}
							disabled={!bot.home}
							label={t(label)}
							onCheckedChange={next => update({ [key]: { on: next, time } })}
						/>
						<Input
							aria-label={t("bots.settings.time", { name: t(label) })}
							className="w-28"
							controlSize="sm"
							disabled={!bot.home}
							onBlur={() => {
								if (on !== null) update({ [key]: { on: true, time } });
							}}
							onChange={event => setTime(event.target.value)}
							type="time"
							value={time}
						/>
					</div>
				))}
			</section>

			<section className="flex flex-col gap-2">
				<SectionLabel>{t("bots.settings.items")}</SectionLabel>
				<Select
					label={t("bots.settings.staleAfter")}
					onChange={event => {
						const days = Number(event.target.value);
						update({ staleDays: days > 0 ? days : null });
					}}
					options={STALE_CHOICES.map(days => ({
						value: String(days),
						label: days === 0 ? t("bots.settings.never") : t("bots.settings.days", { count: days }),
					}))}
					value={String(bot.staleDays ?? 0)}
				/>
			</section>

			<section className="flex flex-col gap-1">
				<SectionLabel>{t("bots.settings.soulMemory")}</SectionLabel>
				<ListRow
					leading={<Smile aria-hidden className="size-4 text-(--sc-text-muted)" />}
					onClick={() => onPage("soul")}
					size="sm"
					title={t("bots.settings.soul")}
					trailing={<ChevronRight aria-hidden className="size-4 text-(--sc-text-subtle)" />}
				/>
				<ListRow
					leading={<Brain aria-hidden className="size-4 text-(--sc-text-muted)" />}
					onClick={() => onPage("memory")}
					size="sm"
					title={t("bots.settings.memory")}
					trailing={<ChevronRight aria-hidden className="size-4 text-(--sc-text-subtle)" />}
				/>
			</section>

			<section className="flex flex-col gap-1">
				<SectionLabel>{t("bots.settings.access")}</SectionLabel>
				<ListRow
					leading={<Users aria-hidden className="size-4 text-(--sc-text-muted)" />}
					meta={
						bot.allPaired
							? t("bots.access.allPaired")
							: bot.reach.length > 0
								? String(bot.reach.length + 1)
								: t("bots.access.onlyYou")
					}
					onClick={bot.device ? undefined : () => onPage("access")}
					size="sm"
					title={t("bots.access.title")}
					trailing={
						bot.device ? undefined : <ChevronRight aria-hidden className="size-4 text-(--sc-text-subtle)" />
					}
				/>
				<ListRow
					description={t("bots.settings.skillsHint")}
					leading={<BookOpen aria-hidden className="size-4 text-(--sc-text-muted)" />}
					onClick={() =>
						void openBotChat(bot, bot.home)
							.then(() => useUiStore.getState().openSettings("tools:skills"))
							.catch(() => {})
					}
					size="sm"
					title={t("bots.settings.skills")}
				/>
			</section>

			<section className="flex flex-col gap-2">
				<SectionLabel>{t("bots.settings.notifications")}</SectionLabel>
				{BOT_QUIET_KINDS.map(kind => (
					<SwitchField
						checked={!bot.quiet.includes(kind)}
						description={t(`bots.settings.notify.${kind}Hint`)}
						key={kind}
						label={t(`bots.settings.notify.${kind}`)}
						onCheckedChange={on => quietToggle(kind, on)}
					/>
				))}
			</section>

			<Button className="self-start" icon={<Trash2 />} onClick={() => setDeleting(true)} variant="danger-soft">
				{t("bots.menu.delete")}
			</Button>
			<ConfirmDialog
				confirmLabel={t("bots.delete.confirm")}
				message={t("bots.delete.message", { folder: bot.folder })}
				onCancel={() => setDeleting(false)}
				onConfirm={() => {
					setDeleting(false);
					void command({ action: "delete", id: bot.id })
						.then(() => onDeleted?.())
						.catch((error: unknown) => toastError({ title: t("bots.delete.failed"), error }));
				}}
				open={deleting}
				title={t("bots.delete.title", { name: bot.name })}
			/>
		</div>
	);
}

function PageHead({ title, onBack }: { title: string; onBack: () => void }) {
	const t = useT();
	return (
		<div className="flex items-center gap-2">
			<Button icon={<ChevronLeft />} onClick={onBack} size="sm" variant="ghost">
				{t("bots.settings.back")}
			</Button>
			<h3 className="text-sc-md font-semibold text-(--sc-text)">{title}</h3>
		</div>
	);
}

/** Its SOUL.md or MEMORY.md: read, edit and save; a file changed on disk under an edit is the owner's call. */
function BotFilePage({ bot, file, onBack }: { bot: Bot; file: "SOUL.md" | "MEMORY.md"; onBack: () => void }) {
	const t = useT();
	const [read, setRead] = useState<BotFile | null>(null);
	const [mode, setMode] = useState<"read" | "edit">("read");
	const [draft, setDraft] = useState("");
	const [conflict, setConflict] = useState<BotFile | null>(null);
	const [status, setStatus] = useState<"saved" | "saving" | "unsaved" | null>(null);
	const [topic, setTopic] = useState<{ name: string; content: string } | null>(null);
	useEffect(() => {
		let live = true;
		window.omp.bots
			.file({ id: bot.id, file })
			.then(found => {
				if (!live) return;
				setRead(found);
				setDraft(found.content);
			})
			.catch((error: unknown) => toastError({ title: t("bots.file.readFailed", { file }), error }));
		return () => {
			live = false;
		};
	}, [bot.id, file, t]);
	const save = async (force = false) => {
		if (!read) return;
		setStatus("saving");
		try {
			const saved = await window.omp.bots.file({
				id: bot.id,
				file,
				content: draft,
				expectedMtimeMs: read.mtimeMs,
				force,
			});
			if (saved.changed) {
				setConflict(saved);
				setStatus("unsaved");
				return;
			}
			setRead(saved);
			setStatus("saved");
		} catch (error) {
			setStatus("unsaved");
			toastError({ title: t("bots.file.saveFailed", { file }), error });
		}
	};
	const lines = draft.split("\n").length;
	const words = draft.split(/\s+/).filter(Boolean).length;
	return (
		<div
			className="flex flex-col gap-3 p-4"
			data-bot-file={file}
			onKeyDown={event => {
				if (event.key === "Escape" && status !== "unsaved") onBack();
			}}
		>
			<PageHead onBack={onBack} title={file === "SOUL.md" ? t("bots.settings.soul") : t("bots.settings.memory")} />
			<div className="flex items-center gap-2">
				<SegmentedChoice
					aria-label={t("bots.file.view")}
					onChange={setMode}
					optionAttr="data-bot-file-mode"
					options={[
						{ value: "read", label: t("bots.file.read") },
						{ value: "edit", label: t("bots.file.edit") },
					]}
					value={mode}
				/>
				<span className="text-sc-xs text-(--sc-text-muted)">{status ? t(`bots.file.status.${status}`) : null}</span>
				{mode === "edit" && (
					<Button
						className="ml-auto"
						disabled={!read || draft === read.content}
						onClick={() => void save()}
						size="sm"
						variant="primary"
					>
						{t("common.save")}
					</Button>
				)}
			</div>
			{conflict && (
				<Banner
					actions={
						<>
							<Button
								onClick={() => void save(true).then(() => setConflict(null))}
								size="sm"
								variant="secondary"
							>
								{t("bots.file.keepMine")}
							</Button>
							<Button
								onClick={() => {
									setRead(conflict);
									setDraft(conflict.content);
									setConflict(null);
									setStatus(null);
								}}
								size="sm"
								variant="ghost"
							>
								{t("bots.file.useTheirs")}
							</Button>
						</>
					}
					variant="warning"
				>
					{t("bots.file.changed", { file })}
				</Banner>
			)}
			{!read ? null : mode === "read" ? (
				<Card className="min-h-40" onDoubleClick={() => setMode("edit")} padding="md">
					{draft.trim() ? (
						<MarkdownRenderer content={draft} />
					) : (
						<p className="text-sc-sm text-(--sc-text-muted)">
							{file === "SOUL.md" ? t("bots.file.emptySoul") : t("bots.file.emptyMemory")}
						</p>
					)}
				</Card>
			) : (
				<TextEditor
					ariaLabel={file}
					autoFocus
					className="min-h-64"
					language="markdown"
					onChange={value => {
						setDraft(value);
						setStatus("unsaved");
					}}
					onSave={() => void save()}
					value={draft}
				/>
			)}
			<p className="text-sc-xs text-(--sc-text-muted)">
				{t("bots.file.count", { lines, words })} · {t("bots.file.doubleClick")}
			</p>
			{file === "MEMORY.md" && read && read.topics.length > 0 && (
				<section className="flex flex-col gap-1">
					<SectionLabel>{t("bots.file.topics")}</SectionLabel>
					{read.topics.map(name => (
						<ListRow
							key={name}
							onClick={() =>
								void window.omp.bots
									.file({ id: bot.id, file: `memory/${name}` })
									.then(found => setTopic({ name, content: found.content }))
									.catch(() => {})
							}
							size="sm"
							title={`memory/${name}`}
						/>
					))}
				</section>
			)}
			{topic && (
				<Modal onClose={() => setTopic(null)} open size="lg" title={`memory/${topic.name}`}>
					<MarkdownRenderer content={topic.content} />
				</Modal>
			)}
		</div>
	);
}

/** Who can ask the bot: the owner always, and the devices paired with this computer the owner lets in (`reach`). */
function BotAccessPage({ bot, onBack }: { bot: Bot; onBack: () => void }) {
	const t = useT();
	const update = useUpdate(bot);
	const peers = useRemoteStore(s => s.state?.host.peers ?? []);
	const allowed = bot.allPaired ? peers.map(peer => peer.deviceId) : bot.reach;
	const names = allowed.map(id => peers.find(peer => peer.deviceId === id)?.name ?? id);
	const toggle = (deviceId: string, on: boolean) =>
		update({ reach: on ? [...allowed, deviceId] : allowed.filter(known => known !== deviceId) });
	return (
		<div className="flex flex-col gap-3 p-4" data-bot-access>
			<PageHead onBack={onBack} title={t("bots.access.title")} />
			<Card data-bot-access-summary padding="md">
				<p className="text-sc-sm text-(--sc-text)">
					{bot.allPaired
						? t("bots.access.allPaired")
						: names.length === 0
							? t("bots.access.summaryYou", { bot: bot.name })
							: t("bots.access.summary", { bot: bot.name, devices: names.join(", ") })}
				</p>
				<p className="mt-1 text-sc-xs text-(--sc-text-muted)">{t("bots.access.what")}</p>
				{(bot.allPaired || names.length > 0) && (
					<Button className="mt-2" onClick={() => update({ reach: [] })} size="sm" variant="ghost">
						{t("bots.access.onlyMe")}
					</Button>
				)}
			</Card>
			<SectionLabel>{t("bots.access.devices")}</SectionLabel>
			{peers.length === 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)">{t("bots.access.noDevices")}</p>
			) : (
				peers.map(peer => (
					<label className="flex items-center gap-2 text-sc-sm" key={peer.deviceId}>
						<Checkbox
							checked={allowed.includes(peer.deviceId)}
							onChange={event => toggle(peer.deviceId, event.target.checked)}
						/>
						<span>{peer.name}</span>
						{!peer.online && (
							<span className="text-sc-xs text-(--sc-text-muted)">{t("bots.access.offline")}</span>
						)}
					</label>
				))
			)}
		</div>
	);
}
