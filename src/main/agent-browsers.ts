/**
 * The browsers the Default browser setting can point agents at, as this computer has them: ego-browser (ego lite;
 * looked up on the spawn PATH like `resolveBin`, plus `~/.local/bin`, where ego's installer puts it) and the Chromium
 * browsers in their standard install places, each with whether the omp Browser Relay extension is loaded in one of
 * its profiles (stock's `omp browser-relay install` writes it; Chrome forbids installing it for the user).
 *
 * The core owns the status snapshot and automatic choice. Main supplies the login-shell PATH and stock relay mode.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentBrowserStatus,
	CHROMIUM_BROWSER_IDS,
	CHROMIUM_BROWSER_NAMES,
	CHROMIUM_RELAY_PORTS,
	type ChromiumBrowserId,
} from "../shared/default-browser";
import { compareVersions } from "../shared/version";
import { core } from "./core/process";
import type { OmpRuntime } from "./local/types";
import { ompRunEnv, systemOmp } from "./omp-runtime";
import { spawnPath } from "./shell-env";

let egoRequest: Promise<string | null> | null = null;

async function egoSearch(home: string) {
	return { pathEnv: await spawnPath(), home, cwd: process.cwd() };
}

async function lookupEgo(): Promise<string | null> {
	const host = core();
	const cached = (await host.call<string | null>("browsers.cachedEgo", {})).result;
	if (cached !== null) return cached;
	return (await host.call<string | null>("browsers.resolveEgo", await egoSearch(homedir()))).result;
}

/** Concurrent callers share the same lookup. A miss or error leaves the next caller free to retry. */
export function resolveEgoBrowser(): Promise<string | null> {
	egoRequest ??= lookupEgo().finally(() => {
		egoRequest = null;
	});
	return egoRequest;
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

const browsers = CHROMIUM_BROWSER_IDS.map(id => ({
	id,
	name: CHROMIUM_BROWSER_NAMES[id],
	port: CHROMIUM_RELAY_PORTS[id],
}));

/** The Chromium browsers installed in their standard places, in `auto` order. */
export async function findChromiumBrowsers(places: BrowserPlaces = systemBrowserPlaces()): Promise<FoundBrowser[]> {
	const params = { places, browsers };
	return (await core().call<FoundBrowser[]>("browsers.find", params)).result;
}

function nativeHostRelay(version: string | undefined): boolean {
	return !version || compareVersions(version, "19.1.0") !== -1;
}

// Stock registers Google's native-messaging key on Windows; its macOS manifests also cover Brave and Chromium.
const NATIVE_HOST_BROWSERS: readonly ChromiumBrowserId[] =
	process.platform === "win32" ? ["chrome"] : ["chrome", "brave", "chromium"];

interface BrowserStatusRead {
	status: AgentBrowserStatus;
	changed: boolean;
}

async function readStatus(refresh: boolean): Promise<BrowserStatusRead> {
	const omp = await systemOmp();
	const native = nativeHostRelay(omp.ok ? omp.runtime.version : undefined);
	const nativeHostBrowsers = native ? NATIVE_HOST_BROWSERS : undefined;
	const host = core();
	if (!refresh) {
		const cached = (await host.call<BrowserStatusRead | null>("browsers.status", { nativeHostBrowsers })).result;
		if (cached) return cached;
	}
	const places = systemBrowserPlaces();
	const ego = await egoSearch(places.home).catch(() => null);
	return (
		await host.call<BrowserStatusRead>("browsers.status", {
			nativeHostBrowsers,
			probe: { places, browsers, ego, refresh },
		})
	).result;
}

/**
 * What this computer has, read once per launch; Settings asks `reprobeAgentBrowserStatus` instead, since the person
 * may install ego-browser or load the extension while the app runs.
 */
export async function agentBrowserStatus(): Promise<AgentBrowserStatus> {
	return (await readStatus(false)).status;
}

/** Probe again; `changed` is whether what sessions are pointed at could differ from the answer held before. */
export function reprobeAgentBrowserStatus(): Promise<BrowserStatusRead> {
	return readStatus(true);
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
