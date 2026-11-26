/**
 * Composer message submission policy. Text-mode slash commands execute
 * server-side through the prompt RPC. Builtins that require an interactive
 * surface are resolved through the same GUI affordance registry as the
 * command palette, so they can never leak into model context as literal text.
 * Session-replacing commands are blocked while a turn runs. Local-only
 * server commands rehydrate after settlement so transcript/context state
 * reflects the mutation.
 */

import type { AvailableCommand, ImageContent, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { toast, toastError } from "../stores/toast";
import { buildCurrentCommandMenu, type CommandAffordance } from "./command-registry";
import { translate } from "./i18n";
import { runManualMaintenance } from "./messages";
import { unavailableSkillTokens } from "./skill-tokens";
import { parseSlashCommand } from "./slash-command";
import type { TabRpc } from "./tab-rpc";

/** Builtin slash commands that replace the session server-side. */
const SESSION_REPLACING_COMMANDS: Record<string, true> = { new: true, clear: true };
// The desktop requires a visible preview/start step even when Core exposes a
// directly executable text command, or command discovery has not completed.
// `drop` is a GUI alias for `delete`, no longer advertised by Core.
const GUI_CONFIRMATION_COMMANDS = new Set(["share", "live", "btw", "delete", "drop"]);

/**
 * `/compact` or `/compact <focus>` as the `compact` RPC's request; undefined for any other command and for
 * `/compact <mode> …` (a token among stock's own `/compact` subcommands), which stays stock's slash command. Without
 * stock's command list (not read yet) only the bare `/compact` takes the RPC, since a mode cannot be told from focus.
 */
export function compactRequest(
	message: string,
	commands: readonly AvailableCommand[],
): { instructions?: string } | undefined {
	const parsed = parseSlashCommand(message.trim());
	if (parsed?.name !== "compact" || parsed.text.charAt(1 + parsed.name.length) === ":") return undefined;
	if (!parsed.args) return {};
	const modes = commands.find(command => command.name === "compact")?.subcommands;
	if (!modes) return undefined;
	const first = parsed.args.split(/\s/, 1)[0]?.toLowerCase();
	return modes.some(mode => mode.name.toLowerCase() === first) ? undefined : { instructions: parsed.args };
}

export type ComposerSubmit =
	/** Session-replacing command while busy — draft stays, warning toasted. */
	| { kind: "blocked" }
	/** Exact `/clear` — native clear_context RPC path (lib/messages.clearSessionContext). */
	| { kind: "clear" }
	/** A GUI-native command opened/executed its affordance synchronously. */
	| { kind: "handled" }
	/** Dispatch this lazy request; on success call {@link settleComposerResponse}. */
	| { kind: "send"; request: () => Promise<RpcResponse> };

function runGuiAffordance(affordance: CommandAffordance, args?: string): boolean {
	const reportFailure = (cause: unknown): void => {
		toastError({ title: translate("palette.failed"), error: cause });
	};
	switch (affordance.kind) {
		case "action":
			void Promise.resolve(affordance.run(args)).catch(reportFailure);
			return true;
		case "toggle":
			void Promise.resolve(affordance.set(!affordance.get())).catch(reportFailure);
			return true;
		case "picker":
		case "window":
			affordance.open();
			return true;
		case "unavailable":
			toast({ variant: "warning", message: affordance.reason || translate("unavailable.tuiOnly") });
			return false;
		case "prompt":
		case "submenu":
			toast({ variant: "warning", message: translate("unavailable.tuiOnly") });
			return false;
	}
}

function findGuiOnlyBuiltin(message: string, commands: AvailableCommand[]): AvailableCommand | undefined {
	const name = parseSlashCommand(message)?.name;
	if (!name) return undefined;
	const command = commands.find(command => command.name === name || command.aliases?.includes(name));
	if (GUI_CONFIRMATION_COMMANDS.has(name) && (!command || command.source === "builtin")) {
		return command ?? { name, source: "builtin", description: name, textModeExecutable: false };
	}
	return command?.source === "builtin" && command.textModeExecutable === false ? command : undefined;
}

export function isGuiOnlyBuiltinCommand(message: string, commands: AvailableCommand[]): boolean {
	return findGuiOnlyBuiltin(message, commands) !== undefined;
}

function runGuiOnlyBuiltin(message: string, commands: AvailableCommand[]): boolean | undefined {
	const wireCommand = findGuiOnlyBuiltin(message, commands);
	if (!wireCommand) return undefined;
	const parsed = parseSlashCommand(message);
	const name = parsed?.name ?? wireCommand.name;
	const args = parsed?.args || undefined;
	const item = buildCurrentCommandMenu(commands).find(
		candidate => candidate.name === wireCommand.name || candidate.aliases?.includes(name),
	);
	if (!item) {
		toast({ variant: "warning", message: translate("unavailable.tuiOnly") });
		return false;
	}
	return runGuiAffordance(item.affordance, args);
}

/**
 * Typed `/mcp <verb> [args]`: stock's headless `/mcp` cannot sign in (it answers "TUI only") and its `reload` only
 * refreshes commands, so a verb the GUI has its own action or window for (the registry's `mcp` submenu) runs that
 * with the args instead of going out as prompt text. Items the registry marks `typedAsPrompt` and verbs with no
 * such affordance still go to stock.
 */
function runGuiMcpVerb(message: string, commands: AvailableCommand[]): boolean | undefined {
	const parsed = parseSlashCommand(message);
	if (parsed?.name !== "mcp") return undefined;
	const [verb, ...rest] = parsed.args.split(/\s+/);
	if (!verb) return undefined;
	const submenu = buildCurrentCommandMenu(commands).find(item => item.name === "mcp")?.affordance;
	if (submenu?.kind !== "submenu") return undefined;
	const item = submenu.items.find(candidate => candidate.name === `mcp ${verb}`);
	if (!item || item.typedAsPrompt) return undefined;
	if (item.affordance.kind !== "action" && item.affordance.kind !== "window") return undefined;
	return runGuiAffordance(item.affordance, rest.join(" ") || undefined);
}

export function planComposerSubmit(input: {
	message: string;
	/** The draft as the user saw it (paste markers folded); a slash command is read from it. Defaults to `message`. */
	typed?: string;
	images: ImageContent[];
	isStreaming: boolean;
	commands: AvailableCommand[];
	rpc?: Pick<TabRpc, "compact" | "prompt" | "steer">;
	/**
	 * Other devices may send to this tab (a shared tab, or a page on a phone), so this window's idea of
	 * "running" can be a beat stale: a plain message goes as a prompt that steers a run still going,
	 * and the host, which holds the one authoritative run state, decides.
	 */
	hostDecides?: boolean;
}): ComposerSubmit {
	const { message, images, isStreaming, commands, rpc = window.omp.rpc } = input;
	const isSlashCommand = (input.typed ?? message).startsWith("/");
	if (isSlashCommand && isStreaming) {
		const commandName = parseSlashCommand(message)?.name;
		if (commandName !== undefined && SESSION_REPLACING_COMMANDS[commandName]) {
			toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
			return { kind: "blocked" };
		}
	}
	// Typed `/clear` (no args) takes the native clear_context RPC — forwarding it
	// as prompt text would fall through the TUI-only builtin and reach the model
	// as a literal user message.
	if (isSlashCommand && message.trim() === "/clear") {
		return { kind: "clear" };
	}
	// Manual compaction can spend minutes in provider summarization. Route `/compact` and `/compact <focus>` through
	// the dedicated RPC so it gets the compact timeout instead of timing out as an 8s prompt while still blocking the
	// RPC queue; the status row shows it running with Esc and Cancel. `/compact <mode> …` stays stock's slash command:
	// the RPC takes no mode.
	const compact = isSlashCommand ? compactRequest(message, commands) : undefined;
	if (compact) {
		return {
			kind: "send",
			request: async () => {
				const { response, cancelled, skipped } = await runManualMaintenance("compact", () =>
					rpc.compact(compact.instructions),
				);
				if (!cancelled && !skipped) return response;
				// The reader stopped it, or there was nothing to compact (said by runManualMaintenance): the command ran
				// its course, so no draft comes back and no failure shows.
				if (cancelled) toast({ variant: "info", message: translate("command.compactCancelled") });
				return { type: "response", command: "compact", success: true, data: { cancelled, skipped } };
			},
		};
	}
	const guiMcp = isSlashCommand ? runGuiMcpVerb(message, commands) : undefined;
	if (guiMcp !== undefined) return { kind: guiMcp ? "handled" : "blocked" };
	const guiHandled = isSlashCommand ? runGuiOnlyBuiltin(message, commands) : undefined;
	if (guiHandled !== undefined) return { kind: guiHandled ? "handled" : "blocked" };
	// Stock sends a `/skill:<name>` token for a skill that is off (or missing) as plain text: say so.
	for (const name of unavailableSkillTokens(message, commands))
		toast({ variant: "warning", message: translate("input.skills.off", { name }) });
	if (!isSlashCommand && isStreaming && !input.hostDecides)
		return { kind: "send", request: () => rpc.steer(message, images) };
	// Only stock knows whether a goal or another sender started a turn since Enter.
	return {
		kind: "send",
		request: () => (isSlashCommand ? rpc.prompt(message, images) : rpc.prompt(message, images, "steer")),
	};
}

/** Post-success settle: rehydrate after local-only slash commands. */
export async function settleComposerResponse(
	response: RpcResponse,
	hydrate: () => Promise<void> = hydrateSession,
): Promise<void> {
	if (!response.success) return;
	const data: unknown = response.data;
	if (
		response.command === "compact" ||
		(data !== null && typeof data === "object" && "agentInvoked" in data && data.agentInvoked === false)
	) {
		await hydrate();
	}
}
