/**
 * The browsers the Default browser setting can point agents at, as this computer has them: ego-browser (ego lite;
 * looked up on the spawn PATH like `resolveBin`, plus `~/.local/bin`, where ego's installer puts it) and the Chromium
 * browsers in their standard install places, each with whether the omp Browser Relay extension is loaded in one of
 * its profiles (stock's `omp browser-relay install` writes it; Chrome forbids installing it for the user).
 *
 * The Chromium browsers are the core process's (`native/ompdesk/crates/core/src/browsers/`): finding them, reading
 * their profiles and relays, writing the extension's copy and opening a browser at its extensions page. This file is
 * its client; it hands over the browsers' names and relay ports, where this machine keeps things and how omp runs,
 * and keeps the PATH lookup (`findOnPath`, which omp's own lookup shares) and the answer held for the launch.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentBrowserStatus,
	CHROMIUM_BROWSER_IDS,
	CHROMIUM_BROWSER_NAMES,
	CHROMIUM_RELAY_PORTS,
	type ChromiumBrowserId,
	type InstalledBrowser,
} from "../shared/default-browser";
import { compareVersions } from "../shared/version";
import { core } from "./core/process";
import type { OmpRuntime } from "./local/types";
import { ompRunEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";
import { findOnPath } from "./spawn";

const BIN = "ego-browser";

let cachedEgo: Promise<string | null> | null = null;

/** Absolute path to `ego-browser`, or null when not installed. Found once per launch; a miss is re-probed next call. */
export function resolveEgoBrowser(): Promise<string | null> {
	if (!cachedEgo) {
		const platform = process.platform;
		const names = platform === "win32" ? [`${BIN}.exe`, `${BIN}.cmd`, BIN] : [BIN];
		const localBin = join(homedir(), ".local", "bin");
		const pending = spawnPath().then(pathEnv =>
			findOnPath(
				names,
				pathEnv,
				platform,
				names.map(name => join(localBin, name)),
			),
		);
		cachedEgo = pending;
		void pending.then(
			bin => {
				if (!bin && cachedEgo === pending) cachedEgo = null;
			},
			() => {
				if (cachedEgo === pending) cachedEgo = null;
			},
		);
	}
	return cachedEgo;
}

export async function egoBrowserInstalled(): Promise<boolean> {
	return (await resolveEgoBrowser().catch(() => null)) !== null;
}

/** Where the machine keeps things; a test points these at a temp folder. */
export interface BrowserPlaces {
	platform: NodeJS.Platform;
	home: string;
	/** macOS folders holding `.app` bundles. */
	appDirs: readonly string[];
	/** Windows `%ProgramFiles%`, `%ProgramFiles(x86)%` and `%LOCALAPPDATA%` roots for installed exes. */
	programDirs: readonly string[];
	/** Windows `%LOCALAPPDATA%`. */
	localAppData: string;
}

export function systemBrowserPlaces(): BrowserPlaces {
	const home = homedir();
	const env = process.env;
	const localAppData = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
	return {
		platform: process.platform,
		home,
		appDirs: ["/Applications", join(home, "Applications")],
		programDirs: [env.ProgramFiles, env["ProgramFiles(x86)"], localAppData].filter(
			(dir): dir is string => typeof dir === "string" && dir.length > 0,
		),
		localAppData,
	};
}

/** A Chromium browser found on disk: what the launch and the relay check need. */
export interface FoundBrowser {
	id: ChromiumBrowserId;
	name: string;
	/** The `.app` bundle (macOS) or the exe (Windows). */
	app: string;
	dataDir: string;
	extensionsUrl: string;
}

/** The browsers in `auto` order, as the page names them, each with its own relay port. */
function named(ports: Record<ChromiumBrowserId, number> | null) {
	return CHROMIUM_BROWSER_IDS.map(id => ({ id, name: CHROMIUM_BROWSER_NAMES[id], port: ports?.[id] }));
}

/** The Chromium browsers installed in their standard places, in `auto` order. */
export async function findChromiumBrowsers(places: BrowserPlaces = systemBrowserPlaces()): Promise<FoundBrowser[]> {
	const params = { places, browsers: named(null) };
	return (await core().call<FoundBrowser[]>("browsers.find", params)).result;
}

/**
 * The installed Chromium browsers with the state of their own relay extension copy. A copy is connected when its
 * relay at `ports[id]` answers `/json/version` 200 within half a second (503 while it waits for the extension).
 */
export async function detectChromiumBrowsers(
	places: BrowserPlaces = systemBrowserPlaces(),
	ports: Record<ChromiumBrowserId, number> | null = CHROMIUM_RELAY_PORTS,
): Promise<InstalledBrowser[]> {
	return (await core().call<InstalledBrowser[]>("browsers.status", { places, browsers: named(ports) })).result;
}

let cachedStatus: { nativeHostRelay: boolean; result: Promise<AgentBrowserStatus> } | null = null;

function nativeHostRelay(version: string | undefined): boolean {
	return !version || compareVersions(version, "19.1.0") !== -1;
}

// Stock registers Google's native-messaging key on Windows; its macOS manifests also cover Brave and Chromium.
const NATIVE_HOST_BROWSERS: readonly ChromiumBrowserId[] =
	process.platform === "win32" ? ["chrome"] : ["chrome", "brave", "chromium"];

async function probeStatus(nativeHostRelay: boolean): Promise<AgentBrowserStatus> {
	const [egoInstalled, browsers] = await Promise.all([
		egoBrowserInstalled(),
		detectChromiumBrowsers(undefined, nativeHostRelay ? null : CHROMIUM_RELAY_PORTS),
	]);
	return { egoInstalled, browsers, ...(nativeHostRelay ? { nativeHostBrowsers: NATIVE_HOST_BROWSERS } : {}) };
}

/**
 * What this computer has, read once per launch; Settings asks `reprobeAgentBrowserStatus` instead, since the person
 * may install ego-browser or load the extension while the app runs.
 */
export async function agentBrowserStatus(): Promise<AgentBrowserStatus> {
	const omp = await systemOmp();
	const native = nativeHostRelay(omp.ok ? omp.runtime.version : undefined);
	if (cachedStatus?.nativeHostRelay !== native) {
		const result = probeStatus(native);
		cachedStatus = { nativeHostRelay: native, result };
		void result.catch(() => {
			if (cachedStatus?.result === result) cachedStatus = null;
		});
	}
	return cachedStatus.result;
}

/** The answer without what changes by itself (a connection), which no session needs telling about. */
function resolvedKey(status: AgentBrowserStatus): string {
	return JSON.stringify([
		status.nativeHostBrowsers,
		status.egoInstalled,
		status.browsers.map(browser => [browser.id, browser.relayInstalled]),
	]);
}

/** Probe again; `changed` is whether what sessions are pointed at could differ from the answer held before. */
export async function reprobeAgentBrowserStatus(): Promise<{ status: AgentBrowserStatus; changed: boolean }> {
	const before = await cachedStatus?.result.catch(() => null);
	cachedStatus = null;
	const status = await agentBrowserStatus();
	return { status, changed: !!before && resolvedKey(before) !== resolvedKey(status) };
}

/**
 * Stock 19.1 registers the path-derived extension ID, so it must install directly in the final folder.
 * Older copies use a browser-specific port and are staged until their assets have been bound to it.
 */
export async function installRelayExtension(
	omp: OmpRuntime,
	id: ChromiumBrowserId,
	home: string = homedir(),
): Promise<string> {
	const nativeHost = nativeHostRelay(omp.version);
	if (nativeHost && !NATIVE_HOST_BROWSERS.includes(id)) {
		throw new Error(
			`omp does not register a native messaging host for ${CHROMIUM_BROWSER_NAMES[id]} on this platform`,
		);
	}
	const params = {
		omp: { bin: omp.bin, env: ompRunEnv(omp.bin, await spawnPath()) },
		id,
		home,
		port: CHROMIUM_RELAY_PORTS[id],
		nativeHost,
	};
	// Stock's install has 30 s; the copy and the clean-up after it are a few small files.
	return (await core().call<string>("browsers.installRelay", params, { timeoutMs: 37_000 })).result;
}

/**
 * Open `browser` at its extensions page: `open -a` on macOS, answered when `open` exits; the exe itself on Windows,
 * detached and outside the core's job, so a browser that was not running outlives OMPdesk.
 */
export async function openExtensionsPage(browser: FoundBrowser): Promise<void> {
	await core().call(
		"browsers.openExtensions",
		{ app: browser.app, url: browser.extensionsUrl },
		{ timeoutMs: 37_000 },
	);
}
