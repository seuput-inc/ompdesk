/**
 * Release-side contract of the in-app updater. A GitHub release carries exactly
 * two downloads (UPDATE_ASSETS). What the updater needs beyond them (version,
 * size and SHA-512 of each installer) rides in the release notes as an HTML
 * comment, which GitHub does not render:
 *
 *   <!-- ompdesk-update {"version":"0.18.0","releaseDate":"…","files":{"mac":{…},"windows":{…}}} -->
 *
 * `.github/workflows/release.yml` (publish job, "Append update metadata")
 * writes it from the files it uploads; this module reads and validates it.
 * No Electron imports, so tests exercise it directly.
 */
import { z } from "zod";
import appCompatibility from "../shared/app-compatibility.json";
import { compareVersions } from "../shared/version";

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

const COMMENT_PATTERN = /<!--\s*ompdesk-update\s+([\s\S]*?)\s*-->/g;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** 64 bytes in padded base64, as electron-updater and `openssl … | base64` write it. */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const SystemVersionSchema = z
	.string()
	.regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/, "minimumSystemVersion must be a numeric OS version")
	.refine(
		version => version.split(".").every(part => Number.isSafeInteger(Number(part))),
		"OS version parts must be safe integers",
	);

const updateFile = <Name extends string>(name: Name) =>
	z.object({
		name: z.literal(name),
		size: z.number().int().positive(),
		sha512: z.string().regex(SHA512_BASE64, "sha512 must be a base64 SHA-512 digest"),
		minimumSystemVersion: SystemVersionSchema.optional(),
	});

const UpdateMetadataSchema = z.object({
	version: z.string().regex(SEMVER, "version must be semver"),
	releaseDate: z.string().datetime(),
	files: z.object({
		mac: updateFile(UPDATE_ASSETS.mac).optional(),
		windows: updateFile(UPDATE_ASSETS.windows).optional(),
	}),
});

export type UpdateMetadata = z.infer<typeof UpdateMetadataSchema>;
export type UpdateFile = NonNullable<UpdateMetadata["files"][UpdatePlatform]>;

/** The fields of GitHub's release payload the updater reads. */
const ReleaseSchema = z.object({
	tag_name: z.string(),
	name: z.string().nullish(),
	body: z.string().nullish(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	assets: z.array(
		z.object({
			id: z.number(),
			name: z.string(),
			size: z.number(),
			/** API asset endpoint; answers `application/octet-stream` with a signed CDN redirect. */
			url: z.string().url(),
		}),
	),
});

export type GitHubRelease = z.infer<typeof ReleaseSchema>;

function describeIssues(error: z.ZodError): string {
	return error.issues.map(issue => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** The one metadata comment in `body`; throws UPDATE_METADATA_ERROR when it is missing, repeated or invalid. */
export function parseUpdateMetadata(body: string | null | undefined): UpdateMetadata {
	const matches = [...(body ?? "").matchAll(COMMENT_PATTERN)];
	if (matches.length === 0) {
		throw new ReleaseFeedError(UPDATE_METADATA_ERROR, "The release notes carry no ompdesk-update metadata comment");
	}
	if (matches.length > 1) {
		throw new ReleaseFeedError(UPDATE_METADATA_ERROR, "The release notes carry more than one ompdesk-update comment");
	}
	let json: unknown;
	try {
		json = JSON.parse(matches[0]?.[1] ?? "");
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new ReleaseFeedError(UPDATE_METADATA_ERROR, `The ompdesk-update comment is not JSON: ${reason}`);
	}
	const parsed = UpdateMetadataSchema.safeParse(json);
	if (!parsed.success) {
		throw new ReleaseFeedError(
			UPDATE_METADATA_ERROR,
			`The ompdesk-update comment is invalid: ${describeIssues(parsed.error)}`,
		);
	}
	return parsed.data;
}

/** Release notes as people read them: the metadata comment removed. */
export function stripUpdateMetadata(body: string | null | undefined): string {
	return (body ?? "").replace(COMMENT_PATTERN, "").trim();
}

/**
 * The release a check considers, from `GET /releases/latest` (one release) or,
 * when pre-releases are allowed, `GET /releases` (newest first): the newest
 * non-draft pre-release, else the newest non-draft release — the rule
 * electron-updater's private GitHub provider applied.
 */
export function pickRelease(payload: unknown, allowPrerelease: boolean): GitHubRelease {
	if (!allowPrerelease) {
		const release = ReleaseSchema.safeParse(payload);
		if (!release.success) {
			throw new ReleaseFeedError(
				RELEASE_LOOKUP_ERROR,
				`Unexpected release payload: ${describeIssues(release.error)}`,
			);
		}
		return release.data;
	}
	const releases = z.array(ReleaseSchema).safeParse(payload);
	if (!releases.success) {
		throw new ReleaseFeedError(
			RELEASE_LOOKUP_ERROR,
			`Unexpected release list payload: ${describeIssues(releases.error)}`,
		);
	}
	const candidates = releases.data.filter(release => !release.draft);
	const release = candidates.find(candidate => candidate.prerelease) ?? candidates[0];
	if (!release) throw new ReleaseFeedError(NO_RELEASE_ERROR, "The repository has no published release");
	return release;
}

/** One platform's update, ready for the updater. */
export interface PlatformRelease {
	version: string;
	releaseDate: string;
	releaseName: string;
	/** Release notes without the metadata comment. */
	notes: string;
	file: UpdateFile;
	/** API asset endpoint of `file`; downloads need the token and `application/octet-stream`. */
	assetUrl: string;
	/** Darwin release, not the macOS product version; absent for the unchanged Windows path. */
	minimumSystemVersion?: string;
}

/**
 * This platform's installer in `release`, checked against the release itself:
 * the comment must name the release's own version, and the file it describes
 * must be an asset of exactly that size.
 */
export function resolvePlatformRelease(release: GitHubRelease, platform: UpdatePlatform): PlatformRelease {
	const metadata = parseUpdateMetadata(release.body);
	if (release.tag_name !== `v${metadata.version}`) {
		throw new ReleaseFeedError(
			UPDATE_METADATA_ERROR,
			`The ompdesk-update comment names ${metadata.version}, but the release is ${release.tag_name}`,
		);
	}
	const file = metadata.files[platform];
	if (!file) {
		throw new ReleaseFeedError(UPDATE_PLATFORM_ERROR, `${release.tag_name} ships no ${platform} installer`);
	}
	const asset = release.assets.find(candidate => candidate.name === file.name);
	if (!asset) {
		throw new ReleaseFeedError(
			UPDATE_METADATA_ERROR,
			`The ompdesk-update comment lists ${file.name}, but ${release.tag_name} has no such asset`,
		);
	}
	if (asset.size !== file.size) {
		throw new ReleaseFeedError(
			UPDATE_METADATA_ERROR,
			`${file.name} is ${asset.size} bytes, but the ompdesk-update comment says ${file.size}`,
		);
	}
	const minimumSystemVersion =
		platform === "mac" ? (file.minimumSystemVersion ?? appCompatibility.minimumDarwin) : undefined;
	if (minimumSystemVersion !== undefined) {
		const order = compareVersions(minimumSystemVersion, appCompatibility.minimumDarwin);
		if (order === null || order < 0) {
			throw new ReleaseFeedError(
				UPDATE_METADATA_ERROR,
				`A macOS update requires a Darwin minimum of ${appCompatibility.minimumDarwin} or newer`,
			);
		}
	}
	return {
		version: metadata.version,
		releaseDate: metadata.releaseDate,
		releaseName: release.name || release.tag_name,
		notes: stripUpdateMetadata(release.body),
		file,
		assetUrl: asset.url,
		...(minimumSystemVersion === undefined ? {} : { minimumSystemVersion }),
	};
}

/** Fail before onResolved: electron-updater's later OS check catches malformed versions and allows them. */
export function assertUpdateSupported(release: PlatformRelease, systemVersion: string): void {
	const minimum = release.minimumSystemVersion;
	if (minimum === undefined) return;
	const order = SystemVersionSchema.safeParse(systemVersion).success ? compareVersions(systemVersion, minimum) : null;
	if (order === null || order < 0) {
		throw new ReleaseFeedError(
			UPDATE_COMPATIBILITY_ERROR,
			`Update ${release.version} requires Darwin ${minimum}; this system reports ${systemVersion}`,
		);
	}
}
