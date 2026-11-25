/**
 * The updater's requests to GitHub and its release feed, all the core's (`crates/core/src/update_feed`): the release
 * lookup, the repository probe and an installer's download go through the core's client with the proxy
 * `proxy.resolve` picks; `updateFeed.resolve` validates the release. The lookup rechecks this OS before it answers.
 */
import { release as osRelease } from "node:os";
import appCompatibility from "../shared/app-compatibility.json";
import { compareVersions } from "../shared/version";
import { CoreError, core } from "./core/process";

/** How the updater reaches GitHub: the proxy `proxy.resolve` picks, and a test's stand-in server for every host. */
interface UpdateNetwork {
	proxy: () => Promise<string | undefined>;
	mirror?: string;
}

let network: UpdateNetwork = { proxy: async () => undefined };

/** Set once by `setupUpdater`. */
export function setUpdateNetwork(next: UpdateNetwork): void {
	network = next;
}

async function route(): Promise<{ proxy?: string; mirror?: string }> {
	const proxy = await network.proxy().catch(() => undefined);
	return { ...(proxy ? { proxy } : {}), ...(network.mirror ? { mirror: network.mirror } : {}) };
}

/** A GitHub API answer as the core read it. */
export interface GithubAnswer {
	status: number;
	body: string;
	/** `x-ratelimit-remaining`, when GitHub sent it. */
	rateLimitRemaining: string | null;
}

/**
 * `GET url` from GitHub's API with `accept` (and the token as `authorization: Bearer` when there is one), answered
 * within `timeoutMs` or failing: a core error `update_timeout` past it, `update_network` when no answer came.
 */
export async function githubGet(
	url: string,
	options: { accept?: string; token?: string; timeoutMs: number },
): Promise<GithubAnswer> {
	const { result } = await core().call<GithubAnswer>(
		"updateFeed.fetch",
		{
			url,
			accept: options.accept ?? "application/vnd.github+json",
			...(options.token ? { token: options.token } : {}),
			...(await route()),
			timeoutMs: options.timeoutMs,
		},
		{ timeoutMs: options.timeoutMs + 5_000 },
	);
	return result;
}

/**
 * Downloads an installer to `file` and checks its SHA-512 (base64, as the release metadata writes it), continuing a
 * `<file>.partial` an earlier attempt left. A `file` already there with that hash is kept. Progress is bytes so far.
 * Fails with the core's `update_status` (message: the HTTP status), `update_stalled`, `update_network`, `update_hash`
 * or `update_write`.
 */
export async function downloadInstaller(options: {
	url: string;
	token?: string;
	file: string;
	size: number;
	sha512: string;
	onProgress: (received: number) => void;
}): Promise<void> {
	subscribeProgress();
	const id = ++downloadSequence;
	progressListeners.set(id, options.onProgress);
	try {
		await core().call(
			"updateFeed.download",
			{
				id,
				url: options.url,
				...(options.token ? { token: options.token } : {}),
				...(await route()),
				file: options.file,
				size: options.size,
				sha512: options.sha512,
			},
			// The core bounds the transfer itself: 30 s without a byte fails it.
			{ timeoutMs: 2 ** 31 - 1 },
		);
	} finally {
		progressListeners.delete(id);
	}
}

const progressListeners = new Map<number, (received: number) => void>();
let progressSubscribed = false;
let downloadSequence = 0;

function subscribeProgress(): void {
	if (progressSubscribed) return;
	progressSubscribed = true;
	core().on("updateFeed.downloadProgress", data => {
		const { id, received } = data as { id: number; received: number };
		progressListeners.get(id)?.(received);
	});
}

/** The only release assets; version-free, so `/releases/latest/download/<name>` stays stable. */
export const UPDATE_ASSETS = {
	mac: "ompdesk-mac-arm64.dmg",
	windows: "ompdesk-windows-setup.exe",
} as const;

export type UpdatePlatform = keyof typeof UPDATE_ASSETS;

/** The release is unusable for updates: comment missing, malformed, or contradicting the release. */
export const UPDATE_METADATA_ERROR = "ERR_OMPDESK_UPDATE_METADATA";
/** The release is valid but ships nothing for this platform. */
export const UPDATE_PLATFORM_ERROR = "ERR_OMPDESK_UPDATE_PLATFORM";
/** The selected update cannot run on this OS; no download or resolved callback may follow. */
export const UPDATE_COMPATIBILITY_ERROR = "ERR_OMPDESK_UPDATE_COMPATIBILITY";
/** No release yet (electron-updater's code, kept: the update log's `kind` and the core name it); settleFailedUpdateCheck reads it as "up to date". */
export const NO_RELEASE_ERROR = "ERR_UPDATER_LATEST_VERSION_NOT_FOUND";
/** GitHub answered the release lookup with an unexpected status or payload. */
export const RELEASE_LOOKUP_ERROR = "ERR_OMPDESK_RELEASE_LOOKUP";

export type ReleaseFeedErrorCode =
	| typeof UPDATE_METADATA_ERROR
	| typeof UPDATE_PLATFORM_ERROR
	| typeof UPDATE_COMPATIBILITY_ERROR
	| typeof NO_RELEASE_ERROR
	| typeof RELEASE_LOOKUP_ERROR;

/** A coded failure of the lookup; the check classifies it by `code`. */
export class ReleaseFeedError extends Error {
	readonly code: ReleaseFeedErrorCode;

	constructor(code: ReleaseFeedErrorCode, message: string) {
		super(message);
		this.name = "ReleaseFeedError";
		this.code = code;
	}
}

const SYSTEM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** One platform's update, ready for the updater. */
interface ResolvedRelease {
	version: string;
	releaseDate: string;
	releaseName: string;
	/** Release notes without the metadata comment. */
	notes: string;
	file: {
		name: (typeof UPDATE_ASSETS)[UpdatePlatform];
		size: number;
		sha512: string;
		minimumSystemVersion?: string;
	};
	/** API asset endpoint of `file`; downloads need the token and `application/octet-stream`. */
	assetUrl: string;
}

export interface MacRelease extends ResolvedRelease {
	minimumSystemVersion: string;
	/** Versioned local name; the GitHub asset name stays version-free. */
	macDownloadName: string;
}

export type PlatformRelease = MacRelease | (ResolvedRelease & { minimumSystemVersion?: undefined });

export async function resolvePlatformRelease(
	payload: string,
	platform: UpdatePlatform,
	allowPrerelease: boolean,
): Promise<PlatformRelease> {
	try {
		const { result } = await core().call<PlatformRelease>("updateFeed.resolve", {
			payload,
			allowPrerelease,
			platform,
			minimumDarwin: appCompatibility.minimumDarwin,
		});
		return result;
	} catch (error) {
		if (!(error instanceof CoreError)) throw error;
		switch (error.code) {
			case "update_invalid_payload":
				// Preserve Response.json()'s native SyntaxError on a malformed GitHub response.
				JSON.parse(payload);
				throw error;
			case "update_invalid_json": {
				// JSON syntax errors are displayed in the running Node version's own words.
				try {
					JSON.parse(error.message);
				} catch (syntax) {
					throw new ReleaseFeedError(
						UPDATE_METADATA_ERROR,
						`The ompdesk-update comment is not JSON: ${syntax instanceof Error ? syntax.message : String(syntax)}`,
					);
				}
				throw new ReleaseFeedError(
					UPDATE_METADATA_ERROR,
					"The ompdesk-update comment exceeds the JSON parser limits",
				);
			}
			case UPDATE_METADATA_ERROR:
			case UPDATE_PLATFORM_ERROR:
			case NO_RELEASE_ERROR:
			case RELEASE_LOOKUP_ERROR:
				throw new ReleaseFeedError(error.code, error.message);
			default:
				throw error;
		}
	}
}

/** The running OS against the release's Darwin minimum; the lookup answers no release this OS cannot run. */
export function assertUpdateSupported(release: PlatformRelease, systemVersion: string): void {
	const minimum = release.minimumSystemVersion;
	if (minimum === undefined) return;
	const valid =
		SYSTEM_VERSION.test(systemVersion) && systemVersion.split(".").every(n => Number.isSafeInteger(Number(n)));
	const order = valid ? compareVersions(systemVersion, minimum) : null;
	if (order === null || order < 0) {
		throw new ReleaseFeedError(
			UPDATE_COMPATIBILITY_ERROR,
			`Update ${release.version} requires Darwin ${minimum}; this system reports ${systemVersion}`,
		);
	}
}

/**
 * How long the release lookup may go unanswered, its body included. A stalled connection (a captive portal, Wi-Fi
 * that dropped mid-request) never answers and never fails, and the check read "Checking for updates…" until the app
 * quit; a body that stalls after the headers did the same (nightly 39521754163: desktop.e2e's check sat at
 * "Checking" past 45 s while every other step has its own deadline).
 */
export const RELEASE_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * The newest release this platform can install, read from GitHub (`/releases/latest`, or the newest page with
 * pre-releases) and validated by the core. Throws a ReleaseFeedError with the code a check is classified by.
 */
export async function lookupRelease(feed: {
	/** `https://api.github.com/repos/<owner>/<repo>` */
	apiRepo: string;
	platform: UpdatePlatform;
	allowPrerelease: boolean;
	token?: string;
	/** `node:os` `release()` by default; injected only to exercise the OS admission without changing the host. */
	systemVersion?: string;
	/** RELEASE_LOOKUP_TIMEOUT_MS; shorter only in a test. */
	timeoutMs?: number;
}): Promise<PlatformRelease> {
	// GitHub lists newest first; one page reaches any pre-release worth testing.
	const url = feed.allowPrerelease ? `${feed.apiRepo}/releases?per_page=30` : `${feed.apiRepo}/releases/latest`;
	const timeoutMs = feed.timeoutMs ?? RELEASE_LOOKUP_TIMEOUT_MS;
	let answer: GithubAnswer;
	try {
		answer = await githubGet(url, { ...(feed.token ? { token: feed.token } : {}), timeoutMs });
	} catch (error) {
		if (error instanceof CoreError && error.code === "update_timeout")
			throw new ReleaseFeedError(
				RELEASE_LOOKUP_ERROR,
				`GitHub did not answer within ${timeoutMs / 1000} s (${url})`,
			);
		throw error;
	}
	// 404 is also what a token without access sees; the check asks the repo endpoint before trusting "no release".
	if (answer.status === 404) throw new ReleaseFeedError(NO_RELEASE_ERROR, `No published release (${url})`);
	if (answer.status < 200 || answer.status >= 300)
		throw new ReleaseFeedError(RELEASE_LOOKUP_ERROR, `GitHub answered ${answer.status} (${url})`);
	const release = await resolvePlatformRelease(answer.body, feed.platform, feed.allowPrerelease);
	assertUpdateSupported(release, feed.systemVersion ?? osRelease());
	return release;
}
