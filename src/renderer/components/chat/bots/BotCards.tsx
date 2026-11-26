/**
 * Bot cards in a transcript (Orca's native-chat bot cards, MIT, re-implemented over OMPdesk's tools and mail):
 *
 * - Item note (FC73, `bot-items/NativeChatBotItemNoteRow.tsx:1-360`): the owner's item changes mailed to a bot's
 *   chat, and the bot's own `ompdesk_item` changes, as one row per item headed by its chip (status glyph, #n, title)
 *   that opens the item; a comment or an answer shows under its row; a move of several items shows three, then
 *   "+N more".
 * - New bot offer (FC70, `NativeChatBotCreateOfferCard.tsx:1-322`): `ompdesk_bot {action:"offer"}` as a card with its
 *   name and purpose; Create bot opens New bot filled in (nothing is made before), and the card reads Created once a
 *   bot of that name exists.
 * - Bot request (FC71, `NativeChatBotRequestCard.tsx:1-186`, `NativeChatClientAskRequestCard.tsx:1-133`): a send or a
 *   report to `bot:<name>[@device]`, as "Asked <bot>" (or "Reported to", "Not sent to") with its subject; the bot's
 *   name opens it on this computer.
 * - Tool added (FC76, `NativeChatToolAddedCard.tsx:1-121`): `ompdesk_app extensions.install_mcp`, with Sign in while
 *   the server needs one and Remove.
 * - A bot chat's turn that ended in NO_REPLY folds to one quiet line that opens to its words.
 *
 * Each has Hide (FC20, `NativeChatCardHideButton.tsx`): that kind leaves every chat (`hidden-cards.ts`).
 */
import { EyeOff, ListTodo, Moon, Send, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { type Bot, ITEM_STATUSES, type Item, type ItemStatus } from "../../../../shared/bots";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { cx, resultBodyText, resultDetails } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { useTabRpc } from "../../../lib/tab-rpc";
import { botNamed, botOfFolder, ensureBots, useBotsStore } from "../../../stores/bots";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import { BotAvatar } from "../../bots/BotAvatar";
import { openBotDialog } from "../../bots/bot-launch";
import { openBotPage } from "../../bots/bot-page";
import { ItemStatusIcon, statusName } from "../../bots/items/ItemStatusIcon";
import { openItem } from "../../bots/items/item-store";
import { Badge, Button, Card, Chip, DisclosureButton, IconButton, LinkButton } from "../../common";
import type { BotCardKind } from "./bot-card-kind";
import { botTarget } from "./bot-card-kind";
import { ensureHiddenCards, hideCardKind } from "./hidden-cards";

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const firstLine = (value: string): string =>
	value
		.split("\n")
		.find(line => line.trim())
		?.trim() ?? "";

/** The computer the chat's tab runs on (absent = this computer): its bots are the ones a transcript names. */
function useTabDevice(): string | undefined {
	const tabId = useRuntimeTabId();
	return useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.device);
}

/** The bot whose folder this chat runs in, on the computer the tab runs on. */
function useChatBot(): Bot | undefined {
	const tabId = useRuntimeTabId();
	const cwd = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.cwd);
	const device = useTabDevice();
	useEffect(() => ensureBots(), []);
	return useBotsStore(s => botOfFolder(s.state.bots, cwd, device));
}

function showItem(bot: Bot, item: Item): void {
	openBotPage(bot.id, "items");
	openItem(bot.id, item.id);
}

function HideButton({ kind }: { kind: BotCardKind }) {
	const t = useT();
	useEffect(() => {
		void ensureHiddenCards().catch(() => {});
	}, []);
	return (
		<IconButton
			className="opacity-0 group-hover/bot-card:opacity-100 group-has-[:focus-visible]/bot-card:opacity-100 [@media(hover:none)]:opacity-100"
			icon={<EyeOff />}
			label={t("chat.botCards.hide", { kind: t(`chat.botCards.kind.${kind}`) })}
			onClick={() => hideCardKind(kind)}
			size="sm"
		/>
	);
}

/** One muted row: its glyph, its words (which share the line), and Hide. */
function Row({
	kind,
	icon,
	children,
	below,
}: {
	kind: BotCardKind;
	icon: ReactNode;
	children: ReactNode;
	below?: ReactNode;
}) {
	return (
		<div className="group/bot-card flex min-w-0 flex-col py-0.5 text-sc-sm" data-bot-card={kind}>
			<div className="flex min-h-7 min-w-0 items-center gap-1.5 text-(--sc-text-muted)">
				<span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span>
				<span className="flex min-w-0 flex-1 items-center gap-1.5">{children}</span>
				<HideButton kind={kind} />
			</div>
			{below}
		</div>
	);
}

// ---- Items (FC73) ------------------------------------------------------------------------------------------------

/** An item named in a line: the live one when this chat's bot still has it. */
function ItemChip({ bot, number, title, status }: { bot?: Bot; number: number; title: string; status?: ItemStatus }) {
	const t = useT();
	const item = useBotsStore(s =>
		bot
			? s.state.items.find(entry => entry.device === bot.device && entry.bot === bot.id && entry.number === number)
			: undefined,
	);
	const shown = item?.status ?? status;
	const name = item?.title ?? title;
	const label = `#${number} ${name}`;
	return (
		<Chip
			className="max-w-64 shrink"
			data-bot-card-item={number}
			icon={shown ? <ItemStatusIcon status={shown} /> : <ListTodo aria-hidden className="size-3.5" />}
			onClick={item && bot ? () => showItem(bot, item) : undefined}
			tooltip={shown ? `${label}, ${statusName(shown, t)}` : label}
		>
			{label}
		</Chip>
	);
}

const isStatus = (value: string): value is ItemStatus => (ITEM_STATUSES as readonly string[]).includes(value);

/** One item's change as the core mails it: `Item #N “title” [status]: The owner …`. */
interface MailedChange {
	number: number;
	title: string;
	status?: ItemStatus;
	said: string;
}

const MAILED = /^Item #(\d+) “(.*)” \[([a-z_]+)\]: (.*)$/;

export function parseItemMail(body: string): MailedChange[] {
	const changes: MailedChange[] = [];
	for (const line of body.split("\n")) {
		const match = MAILED.exec(line);
		if (match) {
			const [, number, title, status, said] = match;
			changes.push({ number: Number(number), title, status: isStatus(status) ? status : undefined, said });
		} else if (changes.length > 0) {
			// A comment's own line breaks.
			changes[changes.length - 1].said += `\n${line}`;
		}
	}
	return changes;
}

/** What the owner did, in the UI's words: the moves on the row, a comment or an answer under it. */
function saidParts(said: string, t: (key: string, params?: Record<string, string>) => string) {
	let line = "";
	let words = "";
	for (const part of said.split(/ (?=The owner )/)) {
		const answered = /^The owner answered: ([\s\S]*)$/.exec(part);
		const commented = /^The owner commented: ([\s\S]*)$/.exec(part);
		const waiting = /^The owner set it to waiting on: ([\s\S]*?)\.?$/.exec(part);
		const noted = /^The owner set it to ([a-z_]+): ([\s\S]*)$/.exec(part);
		const moved = /^The owner set it to ([a-z_]+)\.$/.exec(part);
		const status = (value: string) => (isStatus(value) ? statusName(value, t) : value);
		if (answered) {
			line ||= t("chat.botCards.item.answered");
			words = answered[1];
		} else if (commented) {
			line ||= t("chat.botCards.item.commented");
			words = words ? `${words}\n\n${commented[1]}` : commented[1];
		} else if (waiting) line = t("chat.botCards.item.waiting", { wait: waiting[1] });
		else if (noted) line = t("chat.botCards.item.movedNote", { status: status(noted[1]), note: noted[2] });
		else if (moved) line = t("chat.botCards.item.moved", { status: status(moved[1]) });
		else line ||= part;
	}
	return { line, words };
}

/** Lines a several-item note shows before "+N more". */
const CHANGES_SHOWN = 3;

/** The owner's item changes mailed into this bot chat (`details.id` `item-…`). */
export function ItemNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const bot = useChatBot();
	const [all, setAll] = useState(false);
	const details = resultDetails(message);
	const changes = parseItemMail(text(details?.text));
	if (changes.length === 0) return null;
	const shown = all ? changes : changes.slice(0, CHANGES_SHOWN);
	return (
		<div className="flex flex-col ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)" data-bot-item-note>
			{shown.map(change => {
				const { line, words } = saidParts(change.said, t);
				return (
					<Row
						below={
							words ? (
								<div className="ms-5.5 line-clamp-4 border-s-2 border-(--sc-border-subtle) ps-2 text-(--sc-text-secondary)">
									<MarkdownRenderer content={words} userText />
								</div>
							) : null
						}
						icon={<ListTodo />}
						key={change.number}
						kind="itemNotes"
					>
						<span className="shrink-0">{t("chat.botCards.item.you")}</span>
						<ItemChip bot={bot} number={change.number} status={change.status} title={change.title} />
						<span className="min-w-0 truncate" title={line}>
							{line}
						</span>
					</Row>
				);
			})}
			{changes.length > shown.length && (
				<LinkButton className="ms-5.5 self-start text-sc-xs" onClick={() => setAll(true)} tone="muted">
					{t("chat.botCards.item.more", { count: String(changes.length - shown.length) })}
				</LinkButton>
			)}
		</div>
	);
}

/** The bot's own `ompdesk_item` change: what it did and to which item. */
function ItemToolCard({ args, result }: { args: Record<string, unknown>; result: unknown }) {
	const t = useT();
	const bot = useChatBot();
	const answer = firstLine(resultBodyText(result));
	// "Added item #3 “Title” (planned)." or "Item #3 [working] Title …".
	const match = /#(\d+)\s+(?:“(.*?)”\s+\(([a-z_]+)\)|\[([a-z_]+)\]\s+(.*))/.exec(answer);
	const number = match ? Number(match[1]) : Number(text(args.item).replace(/^#/, "")) || 0;
	const title = match?.[2] ?? match?.[5] ?? text(args.title);
	const rawStatus = match?.[3] ?? match?.[4] ?? "";
	const action = text(args.action);
	const verb = t(
		action === "add"
			? "chat.botCards.item.added"
			: action === "comment"
				? "chat.botCards.item.botCommented"
				: "chat.botCards.item.changed",
	);
	return (
		<Row
			below={
				action === "comment" && text(args.text) ? (
					<div className="ms-5.5 line-clamp-4 border-s-2 border-(--sc-border-subtle) ps-2 text-(--sc-text-secondary)">
						<MarkdownRenderer content={text(args.text)} />
					</div>
				) : null
			}
			icon={<ListTodo />}
			kind="itemNotes"
		>
			<span className="shrink-0">{verb}</span>
			{number > 0 ? (
				<ItemChip bot={bot} number={number} status={isStatus(rawStatus) ? rawStatus : undefined} title={title} />
			) : (
				<span className="min-w-0 truncate">{title}</span>
			)}
		</Row>
	);
}

// ---- A new bot (FC70) --------------------------------------------------------------------------------------------

function OfferCard({ args }: { args: Record<string, unknown> }) {
	const t = useT();
	const name = text(args.name);
	const purpose = text(args.text);
	const device = useTabDevice();
	const made = useBotsStore(s => botNamed(s.state.bots, name, device));
	useEffect(() => ensureBots(), []);
	return (
		<div className="group/bot-card py-1" data-bot-card="botOffers" data-bot-offer={made ? "created" : "open"}>
			<Card padding="row" surface="elevated">
				<div className="flex min-w-0 items-start gap-2.5">
					<BotAvatar
						bot={made ?? { id: text(args.botId) || (device && `${device}:${name}`), name: name || "?" }}
						className="mt-0.5"
						size={32}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-0.5">
						<div className="flex min-w-0 items-center gap-1.5">
							<span className="text-sc-xs text-(--sc-text-muted)">{t("chat.botCards.offer.heading")}</span>
							{made && (
								<Badge size="xs" variant="success">
									{t("chat.botCards.offer.created")}
								</Badge>
							)}
							<span className="ms-auto">
								<HideButton kind="botOffers" />
							</span>
						</div>
						<span className="truncate font-medium">{name}</span>
						{purpose && <p className="text-sc-sm text-(--sc-text-secondary)">{purpose}</p>}
						<div className="mt-1.5 flex gap-1.5">
							{made ? (
								<Button onClick={() => openBotPage(made.id)} size="sm" variant="secondary">
									{t("chat.botCards.offer.open", { name: made.name })}
								</Button>
							) : (
								<Button
									onClick={() =>
										openBotDialog({ kind: "new", draft: { name, purpose: purpose || undefined } })
									}
									size="sm"
								>
									{t("chat.botCards.offer.create")}
								</Button>
							)}
						</div>
					</div>
				</div>
			</Card>
		</div>
	);
}

// ---- A request to a bot (FC71) -----------------------------------------------------------------------------------

function RequestCard({
	toolName,
	args,
	result,
	failed,
}: {
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	failed: boolean;
}) {
	const t = useT();
	const target = botTarget(toolName, args);
	const device = useTabDevice();
	const bot = useBotsStore(s => (target && !target.device ? botNamed(s.state.bots, target.name, device) : undefined));
	const [open, setOpen] = useState(false);
	if (!target) return null;
	const report = toolName.endsWith("_report");
	const subject = firstLine(text(report ? args.text : args.message));
	const heading = failed
		? t("chat.botCards.request.notSent")
		: report
			? t("chat.botCards.request.reported")
			: t("chat.botCards.request.asked");
	const why = failed ? firstLine(resultBodyText(result)) : "";
	return (
		<Row
			below={
				<>
					{why && <p className="ms-5.5 text-sc-xs text-(--sc-danger)">{why}</p>}
					{open && (
						<div className="ms-5.5 border-s-2 border-(--sc-border-subtle) ps-2 text-(--sc-text-secondary)">
							<MarkdownRenderer content={text(report ? args.text : args.message)} />
						</div>
					)}
				</>
			}
			icon={<Send />}
			kind="botRequests"
		>
			<span className={cx("shrink-0", failed && "text-(--sc-danger)")}>{heading}</span>
			<BotAvatar
				bot={
					bot ?? {
						id: text(resultDetails(result)?.botId) || `${target.device ?? device ?? ""}:${target.name}`,
						name: target.name,
					}
				}
				size={16}
			/>
			{bot ? (
				<LinkButton className="shrink-0 font-medium" onClick={() => openBotPage(bot.id)} tone="inherit">
					{bot.name}
				</LinkButton>
			) : (
				<span className="shrink-0 font-medium">{target.name}</span>
			)}
			{target.device && (
				<span className="shrink-0">{t("chat.botCards.request.onDevice", { device: target.device })}</span>
			)}
			{subject && (
				<DisclosureButton
					className="min-w-0 text-(--sc-text-muted)"
					inline
					onToggle={() => setOpen(!open)}
					open={open}
				>
					<span className="min-w-0 truncate">· {subject}</span>
				</DisclosureButton>
			)}
		</Row>
	);
}

// ---- A tool the bot added (FC76) ---------------------------------------------------------------------------------

function ToolAddedCard({ args, result }: { args: Record<string, unknown>; result: unknown }) {
	const t = useT();
	const rpc = useTabRpc();
	const server = args.args && typeof args.args === "object" ? (args.args as Record<string, unknown>) : {};
	const name = text(server.name);
	const needsSignIn = /needs a sign-in/.test(resultBodyText(result));
	const [state, setState] = useState<"added" | "signingIn" | "signedIn" | "removing" | "removed">("added");
	const signIn = () => {
		setState("signingIn");
		rpc.mcpReauth(name)
			.then(res => {
				if (!res.success) throw new Error(res.error ?? "sign-in failed");
				setState("signedIn");
			})
			.catch((error: unknown) => {
				setState("added");
				toastError({ title: t("chat.botCards.tool.signInFailed"), error });
			});
	};
	const remove = () => {
		setState("removing");
		rpc.mcpAction(name, "remove")
			.then(res => {
				if (!res.success) throw new Error(res.error ?? "remove failed");
				setState("removed");
			})
			.catch((error: unknown) => {
				setState("added");
				toastError({ title: t("chat.botCards.tool.removeFailed"), error });
			});
	};
	const removed = state === "removed";
	return (
		<Row icon={<Wrench />} kind="toolsAdded">
			<span className="shrink-0">{removed ? t("chat.botCards.tool.removed") : t("chat.botCards.tool.added")}</span>
			<span className={cx("min-w-0 truncate font-medium", removed && "line-through")}>{name}</span>
			{!removed && needsSignIn && state !== "signedIn" && (
				<LinkButton className="shrink-0" disabled={state !== "added"} onClick={signIn}>
					{t("chat.botCards.tool.signIn")}
				</LinkButton>
			)}
			{!removed && (
				<LinkButton
					className="shrink-0"
					disabled={state !== "added" && state !== "signedIn"}
					onClick={remove}
					tone="muted"
				>
					{t("chat.botCards.tool.remove")}
				</LinkButton>
			)}
		</Row>
	);
}

/** A tool call drawn as a bot card instead of a tool row. */
export function BotToolCard({
	kind,
	toolName,
	args,
	result,
	failed,
}: {
	kind: BotCardKind;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	failed: boolean;
}) {
	switch (kind) {
		case "itemNotes":
			return (
				<div className="ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)">
					<ItemToolCard args={args} result={result} />
				</div>
			);
		case "botOffers":
			return <OfferCard args={args} />;
		case "botRequests":
			return <RequestCard args={args} failed={failed} result={result} toolName={toolName} />;
		case "toolsAdded":
			return <ToolAddedCard args={args} result={result} />;
		default:
			return null;
	}
}

// ---- NO_REPLY ------------------------------------------------------------------------------------------------------

/** A bot chat's turn that had nothing to say: one quiet line that opens to its words. */
export function QuietReply({ text: words }: { text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const body = words.replace(/\n?[^\n]*NO_REPLY[^\n]*\s*$/, "").trim();
	return (
		<div className="ps-(--omp-editorial-inset) pe-(--omp-editorial-edge)" data-bot-quiet-reply>
			<Row icon={<Moon />} kind="quietRuns">
				{body ? (
					<DisclosureButton className="min-w-0" inline onToggle={() => setOpen(!open)} open={open}>
						<span className="truncate">{t("chat.botCards.quiet")}</span>
					</DisclosureButton>
				) : (
					<span className="truncate">{t("chat.botCards.quiet")}</span>
				)}
			</Row>
			{open && body && (
				<div className="ms-5.5 border-s-2 border-(--sc-border-subtle) ps-2 text-sc-sm text-(--sc-text-secondary)">
					<MarkdownRenderer content={body} />
				</div>
			)}
		</div>
	);
}
