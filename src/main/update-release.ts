/** Client for the core's release-note feed. The provider rechecks this OS before exposing any download. */
import appCompatibility from "../shared/app-compatibility.json";
import { compareVersions } from "../shared/version";
import { CoreError, core } from "./core/process";

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
/** electron-updater's code for "no release yet"; settleFailedUpdateCheck reads it as "up to date". */
export const NO_RELEASE_ERROR = "ERR_UPDATER_LATEST_VERSION_NOT_FOUND";
/** GitHub answered the release lookup with an unexpected status or payload. */
export const RELEASE_LOOKUP_ERROR = "ERR_OMPDESK_RELEASE_LOOKUP";

export type ReleaseFeedErrorCode =
	| typeof UPDATE_METADATA_ERROR
	| typeof UPDATE_PLATFORM_ERROR
	| typeof UPDATE_COMPATIBILITY_ERROR
	| typeof NO_RELEASE_ERROR
	| typeof RELEASE_LOOKUP_ERROR;

/** Coded like electron-updater's own errors, so runCheck classifies both the same way. */
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

/** resolveFiles is synchronous; recheck the current OS here and at onResolved, without two admission rules. */
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
