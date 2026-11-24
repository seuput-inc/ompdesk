/**
 * Main's client of the core's `tools` hub kind (`native/ompdesk/crates/core/src/tools`): machine setup, the omp, tool
 * CLI and extension updaters and their schedule as one owner on one queue (slice G, T2). Main keeps what only it has:
 * the typed IPC forwards call these methods, the state items go to the windows (`onState`), the log lines into
 * `gui-runtime.jsonl`, and the core's questions are answered by `asks`. The contract is the module header of
 * `tools/mod.rs`; not wired into `index.ts` yet (T2.2-T2.5 move the parts and cut main over).
 */
import type { CliUpdateState } from "../../shared/cli-update";
import type { ExtensionUpdateState } from "../../shared/extension-update";
import type { RuntimeErrorSource } from "../../shared/ipc-types";
import type { OmpUpdateState } from "../../shared/omp-update";
import type { GitAslrResult, SetupPlatform, SetupState } from "../../shared/setup";
import { type HubItem, hub } from "../core/hub";
import type { ExtensionApplyPlan } from "../extension-reload";
import type { OmpResolution } from "../omp-runtime";
import { writeRuntimeLog } from "../runtime-log";
import { StepStalledError, writeStall } from "../serial-chain";

export interface ToolsOpts {
	platform: SetupPlatform;
	arch: string;
	toolsDir: string;
	userData: string;
	appVersion: string;
	/** `TESTED_OMP_VERSION`: the omp this release was tested with. */
	testedOmp: string;
	/** Setup installs on its own (a packaged app outside headless, or a test installer). */
	automatic: boolean;
	/** Which updaters check on a timer in this launch. */
	scheduled: { omp: boolean; cli: boolean; ext: boolean };
	testInstaller?: string | null;
	testDownload?: { url: string; sha256: string } | null;
	/** The verified list's file a test launch reads instead of the network (`OMP_GUI_TEST_OMP_COMPAT`, unpacked only). */
	testOmpCompat?: string | null;
	/** The core's timers are main's (a test's fake timers drive them). */
	manual?: boolean;
	/** Setup's: `%SystemRoot%`, the agent-desktop the app ships, Bun's root (`BUN_INSTALL` or `~/.bun`). */
	systemRoot?: string;
	agentDesktopBundle?: string | null;
	bunInstall: string;
	/** A test's server on 127.0.0.1 standing in for every host setup's lookups and downloads reach. */
	mirror?: string | null;
	/** `new Intl.Collator().resolvedOptions().locale`: extension rows sort by name as `localeCompare` sorts here. */
	locale?: string;
}

export interface ToolsState {
	setup: SetupState;
	omp: OmpUpdateState;
	cli: CliUpdateState;
	ext: ExtensionUpdateState;
}

export type ToolsPart = keyof ToolsState;

/** What the instance tells main. */
export type ToolsItem =
	| { k: "state"; part: ToolsPart; state: ToolsState[ToolsPart] }
	| { k: "log"; source: RuntimeErrorSource; message: string; details: Record<string, unknown> }
	| { k: "stalled"; chain: string; label: string; ms: number }
	| { k: "timer"; timer: number; ms: number }
	| { k: "clearTimer"; timer: number }
	/** The omp updater installed `version`: main's one "omp updated" toast. */
	| { k: "ompUpdated"; version: string };

/** What the core asks main, until the owners of these move into the core; each may answer with a promise. */
export interface ToolsAsks {
	/** Main's spawn environment: `process.env` with the login shell's (the core adds the proxy). */
	env(): NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
	/** After an install: main's PATH and its login-shell cache again. */
	refreshPath(): Promise<void>;
	/** main's omp resolution again; the version it found, or null. */
	refreshOmp(): Promise<string | null>;
	/**
	 * Setup's detection of omp: main's resolution (`systemOmp()`), resolved again (`refreshSystemOmp()`) when `fresh`
	 * (every detection after the launch's first, which follows an install or an update).
	 */
	ompResolution(fresh: boolean): Promise<OmpResolution>;
	/** omp became usable: restart the tabs that waited, the stats server. */
	ompReady(): void | Promise<void>;
	/** Settles once the first tab is ready or its grace passed (setup's optional installs wait for it). */
	firstTab(): Promise<void>;
	/** Before omp is replaced: stop the stats server and the stock helper. */
	releaseHelpers(): Promise<void>;
	/** After an omp install (`updated`: a new omp runs): start them again, restart the tabs on it. */
	resume(updated: boolean): Promise<void>;
	/** An extension pass's plan for main's own and its hosted tabs. */
	applyExtensionUpdate(plan: ExtensionApplyPlan): void | Promise<void>;
	/** Restart the local tabs waiting for omp. */
	restartWaiting(): void | Promise<void>;
	/** An OS notification; its text from main's table. */
	notify(kind: string, params: Record<string, unknown>): void | Promise<void>;
	/** A stock worker request. */
	stock(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
	/** The working folders of this computer's open local and hosted tabs (project-scoped plugins and skills). */
	workspaceDirs(): string[] | Promise<string[]>;
}

export interface ToolsClientDeps {
	opts: ToolsOpts;
	asks: ToolsAsks;
	/** A part changed: send it to the windows and paired devices. */
	onState(part: ToolsPart, state: ToolsState[ToolsPart]): void;
	/** The omp updater installed a new omp (the focused window's toast). */
	onOmpUpdated?(version: string): void;
}

function answer(asks: ToolsAsks, q: string, item: HubItem): unknown {
	switch (q) {
		case "env":
			return asks.env();
		case "refreshPath":
			return asks.refreshPath();
		case "refreshOmp":
			return asks.refreshOmp();
		case "ompResolution":
			return asks.ompResolution(item.fresh === true);
		case "ompReady":
			return asks.ompReady();
		case "firstTab":
			return asks.firstTab();
		case "releaseHelpers":
			return asks.releaseHelpers();
		case "resume":
			return asks.resume(item.updated === true);
		case "applyExtensionUpdate":
			return asks.applyExtensionUpdate(item.plan as ExtensionApplyPlan);
		case "restartWaiting":
			return asks.restartWaiting();
		case "notify":
			return asks.notify(String(item.kind), (item.params ?? {}) as Record<string, unknown>);
		case "stock":
			return asks.stock(String(item.method), item.params, Number(item.timeoutMs));
		case "workspaceDirs":
			return asks.workspaceDirs();
		default:
			throw new Error(`the tools hub asked what main does not answer: ${q}`);
	}
}

export class ToolsClient {
	readonly #deps: ToolsClientDeps;
	#id: number | null = null;
	/** The core's timers main runs, by the core's id (a `manual` instance). */
	readonly #timers = new Map<number, NodeJS.Timeout>();

	constructor(deps: ToolsClientDeps) {
		this.#deps = deps;
	}

	/** The open instance; opened again on a new core after the hub was lost. */
	#instance(): number {
		if (this.#id !== null) return this.#id;
		const id = hub().nextId();
		hub().open(
			id,
			"tools",
			{ ...this.#deps.opts, now: Date.now() },
			{
				item: item => this.#item(id, item as ToolsItem),
				ask: (q, item) => answer(this.#deps.asks, q, item),
				lost: () => {
					if (this.#id !== id) return;
					this.#id = null;
					this.#clearTimers();
				},
			},
		);
		this.#id = id;
		return id;
	}

	#item(id: number, item: ToolsItem): void {
		switch (item.k) {
			case "state":
				this.#deps.onState(item.part, item.state);
				return;
			case "log":
				writeRuntimeLog({ source: item.source, message: item.message, details: item.details });
				return;
			case "stalled":
				writeStall(new StepStalledError(item.chain, item.label, item.ms));
				return;
			case "timer":
				this.#timers.set(
					item.timer,
					setTimeout(() => {
						this.#timers.delete(item.timer);
						if (this.#id === id) hub().call(id, "fire", { timer: item.timer, now: Date.now() });
					}, item.ms),
				);
				return;
			case "clearTimer":
				clearTimeout(this.#timers.get(item.timer));
				this.#timers.delete(item.timer);
				return;
			case "ompUpdated":
				this.#deps.onOmpUpdated?.(item.version);
				return;
		}
	}

	#clearTimers(): void {
		for (const timer of this.#timers.values()) clearTimeout(timer);
		this.#timers.clear();
	}

	state(): ToolsState {
		return hub().call<ToolsState>(this.#instance(), "state");
	}

	/** Setup's first pass ended: the scheduled updaters check now and then on their timers. */
	start(): boolean {
		return hub().call<boolean>(this.#instance(), "start");
	}

	/** The quit: the running step and what it started end, nothing queued runs. */
	close(): void {
		if (this.#id === null) return;
		hub().call(this.#id, "close");
		hub().close(this.#id);
		this.#id = null;
		this.#clearTimers();
	}

	/** This computer's Cancel: false when nothing ran. */
	setupCancel(): boolean {
		return hub().call<boolean>(this.#instance(), "setup.cancel");
	}

	setupRetry(item: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "setup.retry", { item });
	}

	installForConnection(item: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "setup.installForConnection", { item });
	}

	/** The Git item's Mandatory ASLR override (`setup:git-aslr`); answers `GitAslrResult`. */
	setupGitAslr(action: unknown): Promise<GitAslrResult> {
		return hub().callLater<GitAslrResult>(this.#instance(), "setup.gitAslr", { action });
	}

	/** Update now for omp: joins a pass that runs or waits. */
	ompNow(): Promise<unknown> {
		return hub().callLater(this.#instance(), "omp.now");
	}

	/** BridgeHealth: setup's retry of an omp it holds missing or broken, else the omp updater's repair pass. */
	ompRepair(): Promise<unknown> {
		return hub().callLater(this.#instance(), "omp.repair");
	}

	/** `toolsAutoUpdate` or `ompFollowVerified` changed. */
	ompPrefChanged(): void {
		hub().call(this.#instance(), "omp.prefChanged");
	}

	cliNow(id?: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "cli.now", { id: id ?? null });
	}

	/** Settings opened: list the tools again (the rows arrive as a state item). */
	cliRescan(): Promise<unknown> {
		return hub().callLater(this.#instance(), "cli.rescan");
	}

	/** `toolsAutoUpdate` changed: the state again, and a check now when it turned on in a scheduled launch. */
	cliPrefChanged(): void {
		hub().call(this.#instance(), "cli.prefChanged");
	}

	extNow(key?: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "ext.now", { key: key ?? null });
	}

	/** List the extensions again without checking (Settings opened); answers when listed. */
	extRescan(): Promise<unknown> {
		return hub().callLater(this.#instance(), "ext.rescan");
	}

	/** `toolsAutoUpdate` changed: turning it on checks the extensions at once. */
	extPrefChanged(): void {
		hub().call(this.#instance(), "ext.prefChanged");
	}
}
