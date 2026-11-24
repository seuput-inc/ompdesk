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
import type { SetupPlatform, SetupState } from "../../shared/setup";
import { type HubItem, hub } from "../core/hub";
import type { ExtensionApplyPlan } from "../extension-reload";
import { writeRuntimeLog } from "../runtime-log";
import { StepStalledError, writeStall } from "../serial-chain";

export interface ToolsOpts {
	platform: SetupPlatform;
	arch: string;
	toolsDir: string;
	userData: string;
	appVersion: string;
	/** Setup installs on its own (a packaged app outside headless, or a test installer). */
	automatic: boolean;
	/** Which updaters check on a timer in this launch. */
	scheduled: { omp: boolean; cli: boolean; ext: boolean };
	testInstaller?: string | null;
	testDownload?: { url: string; sha256: string } | null;
	/** The core's timers are main's (a test's fake timers drive them). */
	manual?: boolean;
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
	| { k: "clearTimer"; timer: number };

/** What the core asks main, until the owners of these move into the core; each may answer with a promise. */
export interface ToolsAsks {
	/** Main's spawn environment: `process.env` with the login shell's (the core adds the proxy). */
	env(): NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
	/** After an install: main's PATH and its login-shell cache again. */
	refreshPath(): Promise<void>;
	/** main's omp resolution again; the version it found, or null. */
	refreshOmp(): Promise<string | null>;
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
}

export interface ToolsClientDeps {
	opts: ToolsOpts;
	asks: ToolsAsks;
	/** A part changed: send it to the windows and paired devices. */
	onState(part: ToolsPart, state: ToolsState[ToolsPart]): void;
}

function answer(asks: ToolsAsks, q: string, item: HubItem): unknown {
	switch (q) {
		case "env":
			return asks.env();
		case "refreshPath":
			return asks.refreshPath();
		case "refreshOmp":
			return asks.refreshOmp();
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

	/** Update now for omp: joins a pass that runs or waits. */
	ompNow(): Promise<unknown> {
		return hub().callLater(this.#instance(), "omp.now");
	}

	cliNow(id?: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "cli.now", { id: id ?? null });
	}

	extNow(key?: unknown): Promise<unknown> {
		return hub().callLater(this.#instance(), "ext.now", { key: key ?? null });
	}
}
