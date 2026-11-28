/**
 * A bot's Chats (Orca's `BotChatsPanel.tsx`, `BotChatTreeGroup.tsx`, `BotChatRowMenu.tsx`, `BotNewChatMenuItems.tsx`;
 * FK-B14, B15): every chat of the bot, its home chat first and named so, newest after; a search over their titles;
 * New chat in its folder (with the bot's model); each row opens the chat, and its menu renames or deletes it (never the
 * home chat, which always exists). What a chat's agents opened lists under it in the sidebar's family rows.
 */
import { House, MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Bot } from "../../../shared/bots";
import { useSessionList } from "../../hooks/use-session-list";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { sessionDisplayTitle, sessionHasContent } from "../../lib/session-title";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { Badge, Button, ConfirmDialog, EmptyState, Input, ListRow, MenuButton, SearchField, TimeAgo } from "../common";
import { openBotChat } from "./bot-launch";
import { botChatHome } from "./bot-view";

export function BotChats({ bot }: { bot: Bot }) {
	const t = useT();
	// A paired host's bot chats there: its chats are that host's sessions.
	const { sessions, deleteSession, renameSession } = useSessionList("global", bot.device);
	const tabs = useTabsStore(s => s.tabs);
	const [query, setQuery] = useState("");
	const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
	const [deleting, setDeleting] = useState<{ path: string; title: string } | null>(null);
	const homePath = botChatHome(bot);
	const chats = sessions
		.filter(session => session.cwd === bot.folder && sessionHasContent(session))
		.toSorted(
			(a, b) =>
				Number(b.path === homePath) - Number(a.path === homePath) ||
				Date.parse(b.modified) - Date.parse(a.modified),
		)
		.filter(
			session =>
				!query.trim() ||
				sessionDisplayTitle(session, "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		);
	return (
		<div className="flex flex-col gap-2 p-4" data-bot-chats-panel={bot.id}>
			<div className="flex items-center gap-2">
				<SearchField
					className="min-w-0 flex-1"
					label={t("bots.chats.search")}
					onValueChange={setQuery}
					placeholder={t("bots.chats.search")}
					value={query}
				/>
				<Button
					data-bot-new-chat
					icon={<MessageSquarePlus />}
					onClick={() => void openBotChat(bot, null).catch(() => {})}
					size="sm"
					variant="secondary"
				>
					{t("bots.chats.new")}
				</Button>
			</div>
			{chats.length === 0 ? (
				<EmptyState
					size="sm"
					title={query.trim() ? t("bots.chats.noMatch") : t("bots.row.hello", { name: bot.name })}
				/>
			) : (
				chats.map(session => {
					const home = session.path === homePath;
					const title = home ? t("bots.chats.home") : sessionDisplayTitle(session, "") || t("bots.chats.untitled");
					const tab = tabs.find(entry => entry.sessionPath === session.path && entry.device === bot.device);
					if (renaming?.path === session.path)
						return (
							<Input
								aria-label={t("bots.chats.rename")}
								autoFocus
								controlSize="sm"
								key={session.path}
								onBlur={() => {
									const name = renaming.name.trim();
									setRenaming(null);
									if (name)
										void renameSession(session.path, name).catch((error: unknown) =>
											toastError({ title: t("rename.failed"), error }),
										);
								}}
								onChange={event => setRenaming({ path: session.path, name: event.target.value })}
								onKeyDown={event => {
									if (isImeKeyEvent(event)) return;
									if (event.key === "Escape") setRenaming(null);
									else if (event.key === "Enter") event.currentTarget.blur();
								}}
								value={renaming.name}
							/>
						);
					return (
						<ListRow
							actions={
								<MenuButton
									icon={<MoreHorizontal />}
									items={[
										{
											id: "rename",
											label: t("bots.chats.rename"),
											icon: Pencil,
											onSelect: () =>
												setRenaming({ path: session.path, name: sessionDisplayTitle(session, "") }),
										},
										{
											id: "delete",
											label: t("bots.chats.delete"),
											icon: Trash2,
											danger: true,
											disabled: home || session.path === bot.home || tab?.status === "running",
											disabledReason:
												home || session.path === bot.home
													? t("bots.chats.homeStays")
													: t("bots.chats.running"),
											onSelect: () => setDeleting({ path: session.path, title }),
										},
									]}
									label={t("bots.chats.menu")}
									size="sm"
								/>
							}
							actionsOnHover
							data-bot-chat={home ? "home" : "side"}
							key={session.path}
							leading={home ? <House aria-hidden className="size-4 text-(--sc-accent)" /> : undefined}
							meta={<TimeAgo className="text-(--sc-text-subtle)" iso={session.modified} />}
							onClick={() => void openBotChat(bot, session.path).catch(() => {})}
							secondary={
								tab ? (
									<Badge size="xs" variant={tab.status === "running" ? "accent" : "default"}>
										{tab.status === "running" ? t("bots.chats.replying") : t("bots.chats.open")}
									</Badge>
								) : undefined
							}
							size="sm"
							title={<span className={home ? "font-semibold" : undefined}>{title}</span>}
						/>
					);
				})
			)}
			<ConfirmDialog
				confirmLabel={t("bots.chats.delete")}
				message={t("bots.chats.deleteMessage", { title: deleting?.title ?? "" })}
				onCancel={() => setDeleting(null)}
				onConfirm={() => {
					const target = deleting;
					setDeleting(null);
					if (target)
						void deleteSession(target.path).catch((error: unknown) =>
							toastError({ title: t("bots.chats.deleteFailed"), error }),
						);
				}}
				open={deleting !== null}
				title={t("bots.chats.deleteTitle")}
			/>
		</div>
	);
}
