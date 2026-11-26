/**
 * A bot group's room (Orca's `BotGroupChat.tsx:1-369`, `BotGroupPanelHeader.tsx:1-233`, `BotGroupTurn.tsx:1-300`,
 * `BotGroupReplyPicker.tsx:1-107`, `BotGroupApprovalDock.tsx:1-100`, `BotGroupItemsPanel.tsx:1-244`,
 * `BotGroupFaces.tsx:1-79`, MIT, re-implemented over the core's rooms; FK-B41, FK-B42, FM62):
 *
 * - Header: the members' faces, the group's name and how many bots it holds; its menu changes its members, who
 *   replies (everyone, only those a post @mentions, or one bot), stops every reply still open, and deletes the group
 *   (its bots and their chats stay).
 * - Room: the posts, oldest first; under each the members it asked and how each went (answering while its chat is at
 *   work, answered, stopped, or why it could not be asked). Above the box, a member whose chat waits on the owner's
 *   approval or answer, with Open. The box sends a post (a resend posts once); `@` inserts a member's name.
 * - Items: the members' items in one list, filtered by bot with counts (`ItemsPane`, a group's list).
 */
import { AtSign, MoreHorizontal, Send, Square, Trash2, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Bot, Room, RoomMessage, RoomReplyMode } from "../../../../shared/bots";
import { cx, formatClock, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { MarkdownRenderer } from "../../../lib/markdown";
import { type SessionRun, sessionRun } from "../../../lib/session-run";
import { useBotsStore } from "../../../stores/bots";
import { tabSummary, useHostedSessionsStore } from "../../../stores/hosted-sessions";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import {
	Button,
	ConfirmDialog,
	type ContextMenuItem,
	EmptyState,
	IconButton,
	MenuButton,
	StatusDot,
	Tabs,
	TextArea,
	WorkingArc,
} from "../../common";
import { BotAvatar } from "../BotAvatar";
import { openBotChat, openBotDialog } from "../bot-launch";
import { useBotPage } from "../bot-page";
import { ItemsPane } from "../items/ItemsPane";

/** Up to three members' faces, overlapped (Orca's `BotGroupFaces`). */
export function GroupFaces({ bots, size = 20 }: { bots: readonly Bot[]; size?: number }) {
	const shown = bots.slice(0, 3);
	return (
		<span className="flex shrink-0 items-center" data-bot-group-faces>
			{shown.map((bot, index) => (
				<span className={cx(index > 0 && "-ml-1.5")} key={bot.id}>
					<BotAvatar bot={bot} size={size} />
				</span>
			))}
		</span>
	);
}

/** A room's members as bots, in member order. */
export function roomBots(room: Room, bots: readonly Bot[]): Bot[] {
	return room.members.flatMap(id => bots.find(bot => bot.id === id) ?? []);
}

/** A group row's second line: its newest post, who wrote it (Orca's `BotGroupLatestSchema`), or that it has none. */
export function roomPreview(room: Room, bots: readonly Bot[], t: (key: string) => string): string {
	const latest = room.messages.at(-1);
	if (!latest) return t("bots.groups.noPosts");
	const who =
		latest.author === "owner"
			? t("bots.items.activity.you")
			: (bots.find(bot => bot.id === latest.author)?.name ?? latest.name);
	return `${who}: ${latest.text.replace(/\s+/g, " ").slice(0, 120)}`;
}

type RoomTab = "room" | "items";

export function BotRoom({ room }: { room: Room }) {
	const t = useT();
	const bots = useBotsStore(s => s.state.bots);
	const command = useBotsStore(s => s.command);
	const members = roomBots(room, bots);
	const [tab, setTab] = useState<RoomTab>("room");
	const [deleting, setDeleting] = useState(false);
	const open = room.messages.some(message => message.turns.some(turn => turn.state === "asked"));
	const setMode = (replyMode: RoomReplyMode) =>
		void command({ action: "roomUpdate", id: room.id, replyMode }).catch((error: unknown) =>
			toastError({ title: t("bots.groups.updateFailed"), error }),
		);
	const menu: ContextMenuItem[] = [
		{
			id: "members",
			label: t("bots.groups.editMembers"),
			icon: UsersRound,
			onSelect: () => openBotDialog({ kind: "group", room: room.id }),
		},
		{
			id: "mode-all",
			label: t("bots.groups.replies.all"),
			checked: room.replyMode === "all",
			separatorBefore: true,
			onSelect: () => setMode("all"),
		},
		{
			id: "mode-mentions",
			label: t("bots.groups.replies.mentions"),
			checked: room.replyMode === "mentions",
			onSelect: () => setMode("mentions"),
		},
		...members.map(
			(bot): ContextMenuItem => ({
				id: `mode-${bot.id}`,
				label: t("bots.groups.replies.bot", { name: bot.name }),
				checked: room.replyMode === `bot:${bot.id}`,
				onSelect: () => setMode(`bot:${bot.id}`),
			}),
		),
		{
			id: "stop",
			label: t("bots.groups.stop"),
			icon: Square,
			disabled: !open,
			separatorBefore: true,
			onSelect: () =>
				void command({ action: "roomStop", id: room.id }).catch((error: unknown) =>
					toastError({ title: t("bots.groups.stopFailed"), error }),
				),
		},
		{ id: "delete", label: t("bots.groups.delete"), icon: Trash2, danger: true, onSelect: () => setDeleting(true) },
	];
	const needsYou = useBotsStore(
		s =>
			s.state.items.filter(item => room.members.includes(item.bot) && item.status === "needs_you" && !item.stale)
				.length,
	);
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col" data-bot-room={room.id}>
			<header className="flex items-center gap-3 px-4 pt-4" data-bot-room-header>
				<GroupFaces bots={members} size={28} />
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate text-sc-md font-semibold">{room.name}</h2>
					<p className="truncate text-sc-xs text-(--sc-text-muted)">
						{members.map(bot => bot.name).join(", ")} · {replyModeName(room, members, t)}
					</p>
				</div>
				<MenuButton icon={<MoreHorizontal />} items={menu} label={t("bots.groups.menu")} size="sm" />
			</header>
			<Tabs
				activeId={tab}
				ariaLabel={room.name}
				className="px-4 pt-2"
				onChange={id => setTab(id as RoomTab)}
				tabs={[
					{ id: "room", label: t("bots.groups.tab.room") },
					{ id: "items", label: t("bots.pane.items"), badge: needsYou > 0 ? needsYou : undefined },
				]}
				variant="underline"
			/>
			<div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
				{tab === "room" ? (
					<RoomChat members={members} room={room} />
				) : (
					<ItemsPane bots={members} group owner={room.id} />
				)}
			</div>
			<ConfirmDialog
				confirmLabel={t("bots.groups.deleteConfirm")}
				message={t("bots.groups.deleteMessage")}
				onCancel={() => setDeleting(false)}
				onConfirm={() => {
					setDeleting(false);
					void command({ action: "roomDelete", id: room.id })
						.then(() => useBotPage.setState({ roomId: null }))
						.catch((error: unknown) => toastError({ title: t("bots.groups.deleteFailed"), error }));
				}}
				open={deleting}
				title={t("bots.groups.deleteTitle", { name: room.name })}
			/>
		</div>
	);
}

function replyModeName(
	room: Room,
	members: readonly Bot[],
	t: (key: string, params?: Record<string, string>) => string,
) {
	if (room.replyMode === "all") return t("bots.groups.replies.all");
	if (room.replyMode === "mentions") return t("bots.groups.replies.mentions");
	const bot = members.find(member => `bot:${member.id}` === room.replyMode);
	return bot ? t("bots.groups.replies.bot", { name: bot.name }) : t("bots.groups.replies.all");
}

function RoomChat({ room, members }: { room: Room; members: readonly Bot[] }) {
	const t = useT();
	const command = useBotsStore(s => s.command);
	const tabs = useTabsStore(s => s.tabs);
	const summaries = useHostedSessionsStore(s => s.summaries);
	const [text, setText] = useState("");
	const [sending, setSending] = useState<{ id: string; text: string } | null>(null);
	const end = useRef<HTMLDivElement>(null);
	const runOf = (bot: Bot) => {
		if (!bot.home) return null;
		const tab = tabs.find(entry => entry.sessionPath === bot.home && !entry.device);
		return sessionRun(tabSummary({ summaries }, tab ?? { id: "", sessionPath: bot.home }), tab?.unreadDone);
	};
	const asking = members.flatMap(bot => {
		const ask = runOf(bot)?.ask;
		return ask ? [{ bot, ask }] : [];
	});
	const count = room.messages.length;
	useEffect(() => {
		if (count > 0) end.current?.scrollIntoView({ block: "end" });
	}, [count]);
	const post = (messageId: string, words: string) => {
		setSending({ id: messageId, text: words });
		void command({ action: "roomPost", id: room.id, text: words, messageId })
			.then(() => setSending(null))
			.catch((error: unknown) => {
				// The words come back for another try; the same message id posts them once.
				setSending(null);
				setText(current => current || words);
				toastError({ title: t("bots.groups.postFailed"), error });
			});
	};
	const send = () => {
		const words = text.trim();
		if (!words || sending) return;
		setText("");
		post(crypto.randomUUID(), words);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-bot-room-messages>
				{count === 0 && !sending ? (
					<EmptyState
						description={t("bots.groups.emptyBody")}
						icon={<UsersRound />}
						size="sm"
						title={t("bots.groups.emptyTitle")}
					/>
				) : (
					<div className="flex flex-col gap-3">
						{room.messages.map(message => (
							<RoomPost key={message.id} members={members} message={message} runOf={runOf} />
						))}
						{sending && (
							<div className="text-sc-sm opacity-70" data-bot-room-sending>
								<p className="text-sc-xs text-(--sc-text-muted)">{t("bots.items.comment.sending")}</p>
								<MarkdownRenderer content={sending.text} userText />
							</div>
						)}
						<div ref={end} />
					</div>
				)}
			</div>
			{asking.length > 0 && (
				<div className="flex flex-col gap-1 border-t border-(--sc-border-subtle) px-4 py-2" data-bot-room-asks>
					{asking.map(({ bot, ask }) => (
						<div className="flex items-center gap-2 text-sc-sm" key={bot.id}>
							<StatusDot decorative tone="attention" />
							<BotAvatar bot={bot} size={18} />
							<span className="min-w-0 flex-1 truncate">
								{ask === "approval"
									? t("bots.groups.needsApproval", { name: bot.name })
									: t("bots.groups.needsAnswer", { name: bot.name })}
							</span>
							<Button
								onClick={() => void openBotChat(bot, bot.home).catch(() => {})}
								size="sm"
								variant="secondary"
							>
								{t("bots.needs.open")}
							</Button>
						</div>
					))}
				</div>
			)}
			<div className="border-t border-(--sc-border-subtle) px-3 py-2" data-bot-room-box>
				<div className="flex items-end gap-2">
					<MenuButton
						icon={<AtSign />}
						items={members.map(bot => ({
							id: bot.id,
							label: bot.name,
							onSelect: () =>
								setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}@${bot.name} `),
						}))}
						label={t("bots.groups.mention")}
						side="above"
						size="sm"
						variant="ghost"
					/>
					<TextArea
						aria-label={t("bots.groups.postLabel", { name: room.name })}
						autoGrow
						className="min-w-0 flex-1"
						onChange={event => setText(event.target.value)}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								send();
							}
						}}
						placeholder={t("bots.groups.postPlaceholder", { name: room.name })}
						rows={1}
						value={text}
					/>
					<IconButton
						disabled={!text.trim() || sending !== null}
						icon={<Send />}
						label={t("bots.groups.post")}
						onClick={send}
						variant="primary"
					/>
				</div>
			</div>
		</div>
	);
}

function RoomPost({
	message,
	members,
	runOf,
}: {
	message: RoomMessage;
	members: readonly Bot[];
	runOf: (bot: Bot) => SessionRun | null;
}) {
	const t = useT();
	const owner = message.author === "owner";
	const bot = members.find(member => member.id === message.author);
	return (
		<article className="flex gap-2" data-bot-room-post={message.seq} data-bot-room-author={owner ? "owner" : "bot"}>
			<span className="mt-0.5 shrink-0">
				{bot ? (
					<BotAvatar bot={bot} size={24} />
				) : (
					<span aria-hidden className="block size-6 rounded-full border border-(--sc-border-subtle)" />
				)}
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-1.5 text-sc-xs">
					<span className="font-medium">{owner ? t("bots.items.activity.you") : (bot?.name ?? message.name)}</span>
					<span className="text-(--sc-text-subtle)" title={formatClock(message.at)}>
						{formatTimeAgo(message.at)}
					</span>
				</p>
				<div className="text-sc-sm">
					<MarkdownRenderer content={message.text} userText={owner} />
				</div>
				{message.turns.length > 0 && (
					<ul
						className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sc-xs text-(--sc-text-muted)"
						data-bot-room-turns
					>
						{message.turns.map(turn => {
							const member = members.find(known => known.id === turn.bot);
							const working = turn.state === "asked" && member && runOf(member)?.running;
							return (
								<li className="flex items-center gap-1" data-bot-room-turn={turn.state} key={turn.bot}>
									{working ? <WorkingArc state="turn" /> : null}
									<span className="font-medium">{member?.name ?? turn.name}</span>
									<span title={turn.error}>
										{turn.state === "replied"
											? t("bots.groups.turn.replied")
											: turn.state === "stopped"
												? t("bots.groups.turn.stopped")
												: turn.state === "failed"
													? (turn.error ?? t("bots.groups.turn.failed"))
													: working
														? t("bots.groups.turn.working")
														: t("bots.groups.turn.asked")}
									</span>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</article>
	);
}
