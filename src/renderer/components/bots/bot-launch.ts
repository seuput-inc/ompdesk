/**
 * Making a bot and starting it (Orca's `NewBotDialog.tsx:182-217` create and `BotFirstScreen.tsx:100-214` steps): the
 * core seeds the bot's folder and delivers the first message to its home chat (`bot_first_run.rs`).
 *
 * Opening the home chat is kept per bot (`useBotLaunch`) for the bot page's first screen until its first chat answers.
 * Also the dialogs' store: which bot dialog is open (New bot, Templates, Import, Hand to a bot).
 */
import { create } from "zustand";
import type { Bot, BotImportSource } from "../../../shared/bots";
import type { ScheduleDraft } from "../../../shared/schedules";
import { loadChunk } from "../../lib/chunk-load";
import { translate } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import type { ComposerStore } from "../../stores/composer";
import { useRemoteStore } from "../../stores/remote";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import type { BotTemplate } from "./bot-templates";

/** Where a new bot comes from besides a blank start. */
export type BotImportPick = BotImportSource | { app: "other"; folder: string; name: string };

/** A session handed to the bot it is being made for (Hand to a bot › New bot…). */
export interface BotHandOver {
	/** The tab that holds it. */
	tabId: string;
	title: string;
	text: string;
}

export interface NewBotDraft {
	name: string;
	purpose?: string;
	model?: string | null;
	template?: { template: BotTemplate; line: string };
	importFrom?: BotImportPick;
	handOver?: BotHandOver;
}

export type BotDialog =
	| { kind: "new"; draft?: Partial<NewBotDraft> }
	| { kind: "templates"; query?: string; selected?: string }
	| { kind: "import" }
	| { kind: "hand"; tabId: string; title: string }
	/** New group, or a group's members (`room`: its id). */
	| { kind: "group"; room?: string };

interface BotDialogsStore {
	dialog: BotDialog | null;
	open: (dialog: BotDialog) => void;
	close: () => void;
}

export const useBotDialogs = create<BotDialogsStore>()(set => ({
	dialog: null,
	open: dialog => set({ dialog }),
	close: () => set({ dialog: null }),
}));

export const openBotDialog = (dialog: BotDialog): void => useBotDialogs.getState().open(dialog);

export type LaunchStep = "pending" | "running" | "done" | "failed" | "skipped";

/** The new bot's first screen: its home chat's tab opening (its first message is the core's, read from the bot). */
export interface BotLaunch {
	tabId: string | null;
	start: LaunchStep;
	error?: string;
}

export const useBotLaunch = create<{ launches: Record<string, BotLaunch> }>()(() => ({ launches: {} }));

function noteLaunch(id: string, launch: BotLaunch): void {
	useBotLaunch.setState(state => ({ launches: { ...state.launches, [id]: launch } }));
}

/** The first turn of a bot brought over from another app (Orca's `bot-import.ts:62-77`: a prompt, no parser). */
export function importKickoff(source: BotImportPick): string {
	const app = { openclaw: "OpenClaw", hermes: "Hermes", openbot: "OpenBot", other: "another app" }[source.app];
	return [
		`Bring over the bot "${source.name}" from ${app} instead of the usual first-run setup. Its files are in ${source.folder}; read them there, read-only (SOUL.md, IDENTITY.md, AGENTS.md, USER.md, MEMORY.md, memory/, skills/, config files).`,
		"1. Write your own SOUL.md from who it was and how it worked.",
		"2. Write MEMORY.md from what it remembered, one fact per line.",
		"3. Copy the skills you can use into .omp/skills/<name>/SKILL.md.",
		"4. Keys, tokens and logins stay behind: never copy a secret.",
		"Then say in a few lines what you brought over, what you left and what the owner should set up again.",
	].join("\n");
}

/** What the owner pastes into the old bot when its app is not found on this computer. */
export const IMPORT_EXPORT_PROMPT =
	"Save who you are, what you remember and your skills as plain files in a new folder named <your name>-export in my Downloads folder: SOUL.md (who you are and how you work), MEMORY.md (one fact per line), and skills/<name>/SKILL.md for each skill. Leave out keys, tokens and passwords. Reply with the folder's path.";

/** Resolves with the bot once `ready` says so of the state (60 s at most), else null. */
function whenBot(id: string, ready: (bot: Bot) => boolean): Promise<Bot | null> {
	const { promise, resolve } = Promise.withResolvers<Bot | null>();
	const check = () => useBotsStore.getState().state.bots.find(bot => bot.id === id);
	const now = check();
	if (!now) return Promise.resolve(null);
	if (ready(now)) return Promise.resolve(now);
	const timer = setTimeout(() => {
		stop();
		resolve(null);
	}, 60_000);
	const stop = useBotsStore.subscribe(() => {
		const bot = check();
		if (bot && !ready(bot)) return;
		clearTimeout(timer);
		stop();
		resolve(bot ?? null);
	});
	return promise;
}

/** The owner's Try again on a first message that got no word: the core sends it again when that still holds. */
export function retryKickoff(botId: string): Promise<void> {
	return useBotsStore
		.getState()
		.command({ action: "kickoff", id: botId, asked: true })
		.then(
			() => undefined,
			(error: unknown) => {
				toastError({ title: translate("bots.first.retryFailed"), error });
			},
		);
}

/** Saves a template's routines, off, waking the bot's home chat (so they run as the bot, in its chat). */
async function saveRoutines(bot: Bot, template: BotTemplate): Promise<void> {
	if (template.routines.length === 0) return;
	const homed = await whenBot(bot.id, known => known.home !== null);
	if (!homed?.home) return;
	for (const routine of template.routines) {
		const draft: ScheduleDraft = {
			name: `${homed.name}: ${routine.label}`,
			prompt: `Do your scheduled "${routine.label}" now, as SOUL.md and your skills say. End with NO_REPLY when nothing is worth saying.`,
			cwd: homed.folder,
			frequency: routine.frequency,
			model: homed.model,
			autoApprove: homed.autoApprove,
			enabled: false,
			wakeSession: homed.home,
		};
		await window.omp.schedules.command({ action: "save", draft });
	}
}

/**
 * Makes the bot with its optional first message and opens its home chat;
 * saves a template's routines (off) once the home chat exists; hands a session over once it does. Rejects with the
 * core's reason when the bot could not be made (the dialog shows it); anything after that is the first screen's.
 */
export async function createBot(draft: NewBotDraft): Promise<Bot> {
	const store = useBotsStore.getState();
	const name = draft.name.trim();
	const template = draft.template;
	// The templates' souls and skills load with a template's create only: Sidebar.tsx imports this module statically.
	const words = template ? await loadChunk(() => import("./bot-templates")) : null;
	const kickoff =
		template && words
			? words.templateKickoff(template.template)
			: draft.importFrom
				? importKickoff(draft.importFrom)
				: null;
	const state = await store.command({
		action: "create",
		name,
		...(template && words
			? {
					soul: words.templateSoul(template.template, name, draft.purpose?.trim() || template.line),
					skills: words.templateSkills(template.template),
				}
			: draft.purpose?.trim()
				? { purpose: draft.purpose.trim() }
				: {}),
		...(kickoff ? { kickoff } : {}),
	});
	const bot = state.bots.find(known => known.name === name);
	if (!bot) throw new Error(translate("bots.new.failed"));
	noteLaunch(bot.id, { tabId: null, start: "running" });
	if (draft.model !== undefined)
		await store
			.command({ action: "update", id: bot.id, model: draft.model })
			.catch((error: unknown) => toastError({ title: translate("bots.settings.saveFailed"), error }));
	useUiStore.getState().closeDestination();
	const tabId = await useTabsStore.getState().openTab({ cwd: bot.folder, kind: "agent" });
	if (!tabId) {
		noteLaunch(bot.id, { tabId: null, start: "failed", error: translate("bots.launch.notStarted") });
		return bot;
	}
	noteLaunch(bot.id, { tabId, start: "done" });
	if (template) void saveRoutines(bot, template.template).catch(() => {});
	const handOver = draft.handOver;
	if (handOver)
		void whenBot(bot.id, known => known.home !== null).then(homed =>
			homed
				? useBotsStore
						.getState()
						.command({ action: "handTo", id: homed.id, session: handOver.tabId, text: handOver.text })
						.catch((error: unknown) => toastError({ title: translate("bots.hand.failed"), error }))
				: undefined,
		);
	return bot;
}

/** Opens the bot's home chat (focusing the tab that holds it), or a first chat in its folder when it has none yet. */
export function openBotHome(bot: Bot): void {
	void openBotChat(bot, bot.home).catch(() => {});
}

/**
 * Opens one of the bot's chats, or a new one in its folder (`session` null); `draft` waits in its composer. A paired
 * host's bot chats on that host, as a tab of it (the way its sessions open); while the host is offline nothing opens and
 * a notice says so: the chat lives there.
 */
export async function openBotChat(bot: Bot, session: string | null, draft?: string): Promise<void> {
	if (bot.device) {
		const host = useRemoteStore.getState().state?.hosts.find(known => known.deviceId === bot.device);
		if (host?.state !== "online") {
			const kept = useBotsStore.getState().state.remote?.find(copy => copy.device === bot.device)?.name;
			toast({
				variant: "warning",
				message: translate("bots.remote.offlineChat", { device: host?.name ?? kept ?? "" }),
			});
			return;
		}
	}
	useUiStore.getState().closeDestination();
	const tabs = useTabsStore.getState();
	const held = session ? tabs.tabs.find(tab => tab.sessionPath === session && tab.device === bot.device) : undefined;
	let tabId: string | null = held?.id ?? null;
	const where = bot.device ? { device: bot.device } : {};
	if (held) await tabs.switchTab(held.id);
	else
		tabId = await tabs.openTab(
			session
				? { cwd: bot.folder, sessionPath: session, kind: "agent", ...where }
				: { cwd: bot.folder, kind: "agent", ...where },
		);
	if (tabId && draft) {
		ensureTabRuntime(tabId);
		sessionRuntimeStore<ComposerStore>(tabId, "composer")?.getState().setDraft(draft);
	}
}
