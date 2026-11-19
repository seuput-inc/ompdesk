/**
 * What a tab's omp is launched with: the session it opens, OMPdesk's extensions and the OMPdesk settings it starts
 * with. One bundle for every spawn of a tab, whoever starts it (a new tab, a stored session, a relaunch's saved tab,
 * a paired device's tab, an omp update, a crash, machine setup, the desktop slot), so no start path can launch an omp
 * that lacks an extension, a setting or the session the tab is on. `SidecarManager` gathers the facts per spawn;
 * src/main/session-launch-parity.test.ts drives every start path and compares what they launch.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CREDIT_SPEND_ENV } from "../../resources/gui-bridge/credit-spend-core";
import { KEEP_CLI_ENV } from "../../resources/gui-bridge/kept-jobs-core";
import { MCP_AUTH_ENV, MCP_CWD_ENV, MCP_HUB_ENV } from "../../resources/gui-bridge/mcp-hub-contracts";
import type { AutoTitleSettings } from "../../resources/gui-bridge/modes/auto-title-contracts";
import { AGENT_DESKTOP_ENV, COMPUTER_USE_ENV } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { agentBrowserEnv } from "../../resources/gui-bridge/modes/default-browser-contracts";
import type { DelegationMode } from "../../resources/gui-bridge/modes/delegation-contracts";
import { JUDGE_ASSIST_ENV } from "../../resources/gui-bridge/modes/judge-assist-contracts";
import { MEMORY_ENV } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { SCRATCH_ENV } from "../../resources/gui-bridge/modes/scratch-core";
import type { UserProfile } from "../../resources/gui-bridge/modes/user-profile-contracts";
import { OMPDESK_ROLES_ENV } from "../../resources/gui-bridge/ompdesk-role-contracts";
import type { PromptOriginEnv } from "../../resources/gui-bridge/prompt-origin-contracts";
import type { AccountRotationMode } from "../shared/account-rotation";
import { CREDIT_SPEND_OFF_WORDING } from "../shared/credit-spend";
import { type AgentBrowser, DEFAULT_BROWSER_ENV } from "../shared/default-browser";
import { stripDenylistedFlags } from "../shared/launch-profile";
import type { OmpRuntime } from "./local/types";

/** The bridge extension's entry in the gui-bridge directory. */
const BRIDGE_ENTRY = "index.ts";
/** The extension an omp run without the bridge loads for the Credit use switch alone. */
const CREDIT_SPEND_RUN_ENTRY = "credit-spend-run.ts";
/** `--config` overlay pinning `autoResume: false`, so a new tab never reopens the last session. */
const FRESH_LAUNCH_CONFIG = "fresh-launch.yml";
/**
 * The variable that says whose process it is (`session-processes.ts`): every omp gets its tab's tag, and whatever the
 * omp starts inherits it, however deep and after its parent is gone.
 */
export const SESSION_TAG_ENV = "OMP_GUI_SESSION_TAG";

/**
 * Every variable a spawn sets from its own launch (`sessionEnv`). One inherited from the environment OMPdesk was
 * started in (a dev or test run launched from an OMPdesk session's shell) describes that other app's session: its
 * bridge socket, delegation, memory file. So none is ever passed through; each spawn sets only its own.
 */
export const SESSION_OWNED_ENV = [
	"OMP_GUI_BRIDGE",
	"OMP_GUI_REPLY_LANGUAGE",
	DEFAULT_BROWSER_ENV,
	COMPUTER_USE_ENV,
	AGENT_DESKTOP_ENV,
	"OMP_GUI_USER_PROFILE",
	"OMP_GUI_NEXT_PROMPT",
	"OMP_GUI_AUTO_TITLE",
	JUDGE_ASSIST_ENV,
	"OMP_GUI_PROMPT_ORIGIN",
	"OMP_GUI_DELEGATION",
	"OMP_GUI_ACCOUNT_ROTATION",
	"OMP_GUI_ACCOUNT_ROTATION_STATE",
	CREDIT_SPEND_ENV,
	OMPDESK_ROLES_ENV,
	"OMP_GUI_REA_ROOT",
	MCP_HUB_ENV,
	MCP_AUTH_ENV,
	MCP_CWD_ENV,
	"OMP_GUI_PSTACK",
	"OMP_GUI_ECC",
	MEMORY_ENV,
	SESSION_TAG_ENV,
	SCRATCH_ENV,
	KEEP_CLI_ENV,
] as const;

/** `env` without any variable a session owns (`SESSION_OWNED_ENV`). */
export function withoutSessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const own = { ...env };
	for (const key of SESSION_OWNED_ENV) delete own[key];
	return own;
}

/** What a tab knows about its session before a spawn. */
export interface TabSession {
	/** The session the tab is on: the file it was asked to open, then the one its omp reported (`get_state`). */
	readonly path: string | null;
	/** A new tab that has not booted yet: stock's `autoResume` must not reopen another session in its folder. */
	readonly isNew: boolean;
}

/** `{ session }`: `--session <file>`; `new`: a new session in the folder (`autoResume` pinned off); `default`: omp's own. */
export type SessionOpen = { readonly session: string } | "new" | "default";

/**
 * A written session is reopened. A session stock never wrote (it writes a new session's file at the first answer:
 * a tab restored or restarted before its first turn ended) opens nothing, and `--session` on it only fails ("Session
 * not found"), so the tab starts a new session in its folder, as a new tab does. Only a tab with no session at all (it
 * moved to another folder) leaves the choice to omp.
 */
export function sessionOpen(tab: TabSession, written: (path: string) => boolean = existsSync): SessionOpen {
	if (tab.path && written(tab.path)) return { session: tab.path };
	return tab.isNew || tab.path ? "new" : "default";
}

/** OMPdesk's own extensions for a spawn (sidecar-factory's `builtinMcp`): `-e` roots, REA's root and their variables. */
export interface BuiltinLaunch {
	readonly args: readonly string[];
	readonly root?: string;
	readonly env?: Readonly<Record<string, string>>;
}

/** The OMPdesk settings a tab's omp starts with, read at its spawn; each absent one leaves the bridge's default. */
export interface SessionSettings {
	/** The reply language's English name (`Korean`). */
	readonly replyLanguage?: string;
	readonly userProfile?: UserProfile;
	readonly nextPrompt?: NextPromptSettings;
	/** `suppressed`: the user's own environment turned stock's automatic titles off. */
	readonly autoTitle?: AutoTitleSettings;
	readonly judgeAssist?: boolean;
	readonly delegation?: DelegationMode;
	readonly accountRotation?: AccountRotationMode;
	/** The even-rotation ledger every local omp shares. */
	readonly accountRotationLedger?: string;
	/** Settings › Models & accounts › Credit use: a spent plan may run on credits and extra usage. */
	readonly creditSpend?: boolean;
	/** The OMPdesk model-role picks every local omp shares. */
	readonly ompdeskRolesFile?: string;
	readonly browser?: AgentBrowser;
}

/** One spawn of a tab's omp, resolved. */
export interface OmpLaunch {
	readonly open: SessionOpen;
	/** The gui-bridge directory and this process's bridge socket; absent: no bridge (tests). */
	readonly bridge?: { readonly dir: string; readonly address: string };
	/** `--model` for a boot that failed on its model (sidecar.ts `#bootModelFallback`, `#noModelBoot`). */
	readonly model?: string;
	readonly builtin: BuiltinLaunch;
	/** The person's own flags (the extraFlags seam and the workspace's launch profile). */
	readonly userFlags: readonly string[];
	readonly settings: SessionSettings;
	/** The paired device a host tab runs for: the bridge journals its prompts as that device's. */
	readonly origin?: PromptOriginEnv;
	/** The tab's process tag (`SESSION_TAG_ENV`); absent: its processes are not followed (tests). */
	readonly processTag?: string;
	/** The tab's scratch folder (`SCRATCH_ENV`, session-scratch.ts); absent: the agent is told of none. */
	readonly scratchDir?: string;
	/** The `ompdesk` CLI a background bash job runs under (`KEEP_CLI_ENV`); absent: such jobs end with omp (tests). */
	readonly keepCli?: string;
}

/**
 * omp's arguments. The person's flags come last, stripped of the code-controlled ones (pair-aware), so they can
 * never override the session, the bridge or an extension, while a value that merely looks like one survives.
 */
export function ompArgs(launch: OmpLaunch): string[] {
	const { open, bridge } = launch;
	const args = ["--mode", "rpc-ui"];
	if (typeof open === "object") args.push("--session", open.session);
	else if (open === "new" && bridge) args.push("--config", join(bridge.dir, FRESH_LAUNCH_CONFIG));
	if (launch.model) args.push("--model", launch.model);
	if (bridge) args.push("-e", join(bridge.dir, BRIDGE_ENTRY));
	args.push(...launch.builtin.args, ...stripDenylistedFlags([...launch.userFlags]));
	return args;
}

/** The variables the tab's omp gets from OMPdesk; every key is in `SESSION_OWNED_ENV`. */
export function sessionEnv(launch: OmpLaunch): Record<string, string> {
	const { settings, builtin } = launch;
	const env: Record<string, string> = {};
	if (launch.bridge) env.OMP_GUI_BRIDGE = launch.bridge.address;
	if (settings.replyLanguage) env.OMP_GUI_REPLY_LANGUAGE = settings.replyLanguage;
	if (settings.userProfile && (settings.userProfile.name || settings.userProfile.experience)) {
		env.OMP_GUI_USER_PROFILE = JSON.stringify(settings.userProfile);
	}
	if (settings.nextPrompt) env.OMP_GUI_NEXT_PROMPT = JSON.stringify(settings.nextPrompt);
	if (settings.autoTitle) env.OMP_GUI_AUTO_TITLE = JSON.stringify(settings.autoTitle);
	if (settings.judgeAssist !== undefined) env[JUDGE_ASSIST_ENV] = settings.judgeAssist ? "1" : "0";
	if (launch.origin) env.OMP_GUI_PROMPT_ORIGIN = JSON.stringify(launch.origin);
	if (settings.delegation && settings.delegation !== "default") env.OMP_GUI_DELEGATION = settings.delegation;
	if (settings.accountRotation) env.OMP_GUI_ACCOUNT_ROTATION = settings.accountRotation;
	if (settings.accountRotationLedger) env.OMP_GUI_ACCOUNT_ROTATION_STATE = settings.accountRotationLedger;
	if (settings.creditSpend !== undefined) env[CREDIT_SPEND_ENV] = settings.creditSpend ? "1" : "0";
	if (settings.ompdeskRolesFile) env[OMPDESK_ROLES_ENV] = settings.ompdeskRolesFile;
	if (builtin.root) env.OMP_GUI_REA_ROOT = builtin.root;
	if (settings.browser) env[DEFAULT_BROWSER_ENV] = agentBrowserEnv(settings.browser);
	if (launch.processTag) env[SESSION_TAG_ENV] = launch.processTag;
	if (launch.scratchDir) env[SCRATCH_ENV] = launch.scratchDir;
	if (launch.keepCli) env[KEEP_CLI_ENV] = launch.keepCli;
	return { ...env, ...builtin.env };
}

/** What an `omp -p` run OMPdesk starts beside its sessions carries, so the Credit use switch holds there too. */
export interface CreditSpendRun {
	args: string[];
	env: Record<string, string>;
}

/**
 * A scheduled run and a PR draft are `omp -p` with no bridge, so nothing applied the switch to them: stock alone
 * serves a spent plan from credits. They load the extension that installs the bridge's check
 * (resources/gui-bridge/credit-spend-run.ts) and get the switch as a tab's spawn does.
 */
export function creditSpendRun(bridgeDir: string, enabled: boolean): CreditSpendRun {
	return {
		args: ["-e", join(bridgeDir, CREDIT_SPEND_RUN_ENTRY)],
		env: { [CREDIT_SPEND_ENV]: enabled ? "1" : "0" },
	};
}

/** Why the commit-message run was not started: with Credit use off, the plan is spent or could not be checked. */
export class CreditSpendRefusal extends Error {}

const UNCHECKED_COMMIT =
	"Commit message not generated: Credit use is off and this session's omp could not check the account's plan first. Write the message yourself, or turn Credit use on in Settings › Models & accounts.";

/**
 * `runtime` as a tab's local commands run omp beside the session, so the Credit use switch holds there too:
 * - `omp -p` (a PR draft) carries `creditSpendRun`'s extension and switch.
 * - `omp commit` (the commit-message button) takes no extension and builds its own AuthStorage (stock
 *   commit/pipeline.ts), so with the switch off the tab's omp checks first (`commitCheck`: gui-bridge
 *   `credit_spend_commit_check`) and a refusal, or a check that could not run, ends it before it starts.
 * Every other omp command calls no model and runs as it was.
 */
export function withCreditSpendRuns(
	runtime: OmpRuntime,
	guard: { bridgeDir: string; enabled: () => boolean; commitCheck: () => Promise<unknown> },
): OmpRuntime {
	return {
		...runtime,
		run: async (args, opts) => {
			const enabled = guard.enabled();
			if (args[0] === "-p") {
				const run = creditSpendRun(guard.bridgeDir, enabled);
				return runtime.run([...args, ...run.args], { ...opts, env: { ...opts?.env, ...run.env } });
			}
			if (args[0] === "commit" && !enabled) {
				try {
					await guard.commitCheck();
				} catch (error) {
					const text = error instanceof Error ? error.message : String(error);
					if (!CREDIT_SPEND_OFF_WORDING.test(text)) throw new CreditSpendRefusal(UNCHECKED_COMMIT);
					// The check's own words, without stock's error code and retry hint.
					const reason = text.replace(/^usage_limit_reached: /, "").replace(/ retry-after-ms=\d+$/, "");
					throw new CreditSpendRefusal(`Commit message not generated: ${reason}`);
				}
			}
			return runtime.run(args, opts);
		},
	};
}
