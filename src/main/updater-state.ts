import * as path from "node:path";
import { getSystemErrorMap } from "node:util";
import type { UpdateAccess, UpdateStatus, UpdateTokenSource } from "../shared/ipc-types";

/**
 * `/Applications/ompdesk.app` from `/Applications/ompdesk.app/Contents/MacOS/ompdesk`; undefined outside a bundle.
 * macOS paths only, so POSIX path rules on every platform the tests run on.
 */
export function macBundlePath(execPath: string): string | undefined {
	const macOsDir = path.posix.dirname(execPath);
	const bundle = path.posix.dirname(path.posix.dirname(macOsDir));
	return bundle.endsWith(".app") && path.posix.basename(macOsDir) === "MacOS" ? bundle : undefined;
}

/**
 * A bundle the app may replace itself: not on a mounted disk image (read-only)
 * and not App Translocation's randomized read-only copy of a quarantined app.
 * Writability is checked separately against the real filesystem.
 */
export function isSwappableBundleLocation(bundlePath: string): boolean {
	return !bundlePath.startsWith("/Volumes/") && !bundlePath.includes("/AppTranslocation/");
}

/**
 * Detached swap run after the app exits (`bash -c SWAP_SCRIPT swap <pid>
 * <staged.app> <dest.app> <relaunch 0|1> <log> <start mark> <expected version> [relaunch args…]`): wait for the
 * old process, copy the verified staged bundle next to the destination, then exchange them with a rollback if the
 * final move fails. Runs once and exits; never a launchd job.
 *
 * Relaunch (1) keeps the old bundle as `<dest>.previous` until the new app proves it started: the helper removes a
 * stale start mark, reopens the app and polls up to `OMPDESK_SWAP_START_WAIT_S` seconds (default 120) for the mark
 * main writes once its first window's page loaded (`<userData>/app-started.json`, `START_MARK_FILE`) with the
 * expected version. Seen: `.previous` goes, `started`. Not seen (the new app died, hung, or is a different build):
 * every process under `<dest>/Contents/` is ended (TERM, KILL after 5 s), `.previous` moves back and is reopened,
 * `start failed; previous app restored` (`start failed; previous app lost` when it cannot move back, leaving what is
 * there). No dialog. The log's last outcome line wins (`lastSwapEntry`).
 *
 * Without a relaunch (0, the install at an approved quit) nothing is reopened, so there is nothing to start-check:
 * `.previous` goes at once, as before; that path has no rollback.
 *
 * Orderings: the mark is removed before `open`, so a mark in the file was written by an app started after it; the
 * mark is written by rename, so a read sees none or all of it; one last look follows the wait, so a mark that
 * lands in the final tick is not lost to a rollback decision made a tick earlier.
 */
export const SWAP_SCRIPT = `
pid="$1" src="$2" dest="$3" relaunch="$4" log="$5" mark="$6" expect="$7"
shift 7
exec >>"$log" 2>&1
echo "swap $(date): $src -> $dest"
for _ in $(seq 1 150); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$pid" 2>/dev/null; then echo "app still running; swap skipped"; exit 1; fi
[ -d "$src" ] || { echo "staged app missing"; exit 1; }
staging="$dest.updating" old="$dest.previous"
rm -rf "$staging" "$old"
ditto "$src" "$staging" || { rm -rf "$staging"; echo "copy failed"; exit 1; }
xattr -dr com.apple.quarantine "$staging" 2>/dev/null
if [ -e "$dest" ]; then mv "$dest" "$old" || { rm -rf "$staging"; echo "cannot move old app"; exit 1; }; fi
if ! mv "$staging" "$dest"; then
  [ -e "$old" ] && mv "$old" "$dest"
  echo "install failed; previous app restored"; exit 1
fi
rm -rf "$src"
echo "installed"
if [ "$relaunch" != "1" ]; then rm -rf "$old"; exit 0; fi
launch() { if [ "$#" -gt 0 ]; then open -n "$dest" --args "$@"; else open -n "$dest"; fi; }
started() { [ -f "$mark" ] && grep -Fq "\\"version\\":\\"$expect\\"" "$mark"; }
under_dest() { ps -axww -o pid= -o command= | while read -r p c; do case "$c" in "$dest/Contents/"*) echo "$p";; esac; done; }
wait_s="\${OMPDESK_SWAP_START_WAIT_S:-120}"
case "$wait_s" in ''|*[!0-9]*) wait_s=120;; esac
rm -f "$mark"
launch "$@"
echo "waiting for the new app to start"
ticks=0
while [ "$ticks" -lt $((wait_s * 5)) ] && ! started; do sleep 0.2; ticks=$((ticks + 1)); done
if started; then rm -rf "$old"; echo "started"; exit 0; fi
pids=$(under_dest)
if [ -n "$pids" ]; then
  kill -TERM $pids 2>/dev/null
  ticks=0
  while [ "$ticks" -lt 25 ] && [ -n "$(under_dest)" ]; do sleep 0.2; ticks=$((ticks + 1)); done
  pids=$(under_dest)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
fi
if [ -d "$old" ] && rm -rf "$dest" && mv "$old" "$dest"; then
  echo "start failed; previous app restored"
  launch "$@"
else
  echo "start failed; previous app lost"
fi
`;

/** Why a DMG could not be staged; updater.ts maps it to user-facing copy. */
export class StageBundleError extends Error {
	readonly reason: "mount" | "missing" | "copy" | "verify" | "compatibility";

	constructor(reason: StageBundleError["reason"], message: string) {
		super(message);
		this.name = "StageBundleError";
		this.reason = reason;
	}
}

export interface StageBundleRequest {
	dmgPath: string;
	version: string;
	ownBundle: string;
}

interface StageFailure {
	message: string;
	reason?: StageBundleError["reason"];
	errno?: number;
	errors?: StageFailure[];
}

export type StageBundleReply = { staged: string } | { error: StageFailure };

function stageError(failure: StageFailure): Error {
	if (failure.errors) return new AggregateError(failure.errors.map(stageError), failure.message);
	if (failure.errno !== undefined) {
		const [code, description] = getSystemErrorMap().get(failure.errno) ?? ["UNKNOWN", "unknown error"];
		return new Error(`${code}: ${description}, ${failure.message}`);
	}
	return failure.reason ? new StageBundleError(failure.reason, failure.message) : new Error(failure.message);
}

export async function stageBundleFromDmg(
	request: StageBundleRequest,
	stage: (request: StageBundleRequest) => Promise<StageBundleReply>,
): Promise<string> {
	const reply = await stage(request);
	if ("error" in reply) throw stageError(reply.error);
	return reply.staged;
}

/**
 * electron-updater may resolve without emitting an available/not-available
 * event (notably in unpackaged builds). Never leave the public state machine
 * stuck in `checking` after the request itself has finished.
 */
export function settleIncompleteUpdateCheck(
	status: UpdateStatus,
	manual: boolean,
	noResultMessage = "Couldn't check for updates.",
): UpdateStatus {
	if (status.state !== "checking") return status;
	return manual ? { state: "error", message: noResultMessage } : { state: "idle" };
}

/* ------------------------------------------- release access (token optional) */

export interface ResolvedUpdateToken {
	token: string;
	source: UpdateTokenSource;
}

/**
 * First usable token in precedence order (env → gh → stored). Lookups run
 * lazily so a token found in the environment never spawns `gh`.
 */
export async function firstUpdateToken(
	lookups: readonly (readonly [UpdateTokenSource, () => Promise<string | undefined> | string | undefined])[],
): Promise<ResolvedUpdateToken | undefined> {
	for (const [source, lookup] of lookups) {
		const token = (await lookup())?.trim();
		if (token) return { token, source };
	}
	return undefined;
}

/**
 * `GET /repos/{owner}/{repo}` status → access. GitHub answers 404 (not 403)
 * for a private repo the caller cannot see, so both mean "no access". A 403
 * with `rateLimited` (`x-ratelimit-remaining: 0`) is the hourly limit, which
 * says nothing about access and reads as a network-class failure.
 */
export function classifyRepoAccess(status: number, rateLimited = false): UpdateAccess {
	if (status >= 200 && status < 300) return "ok";
	if (status === 401) return "invalid";
	if (status === 403 && rateLimited) return "network";
	if (status === 403 || status === 404) return "denied";
	return "network";
}

/**
 * Status for a failed check once repo access is known. `message` is the
 * user-facing copy; `detail` (the raw updater error) rides along for the
 * banner's tooltip and Settings.
 */
export function settleFailedUpdateCheck(
	access: UpdateAccess,
	errorCode: string | undefined,
	message: string,
	currentVersion: string,
	manual: boolean,
	detail?: string,
): UpdateStatus {
	if (access === "invalid" || access === "denied" || access === "missing") {
		return { state: "auth-required", reason: access };
	}
	// Access is fine and GitHub has no release yet: nothing newer exists.
	if (access === "ok" && errorCode === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND") {
		return { state: "not-available", version: currentVersion };
	}
	return detail && detail !== message
		? { state: "error", message, detail, showInBanner: manual }
		: { state: "error", message, showInBanner: manual };
}

/* -------------------------------------------------------- installer transfer */

/**
 * At most one installer transfer at a time: a second one would append to the
 * same `.partial` and fail the SHA-512 check. `start` hands back the transfer
 * already running instead of starting another.
 */
export class SingleTransfer {
	#running: Promise<void> | undefined;

	get running(): boolean {
		return this.#running !== undefined;
	}

	start(transfer: () => Promise<void>): Promise<void> {
		this.#running ??= transfer().finally(() => {
			this.#running = undefined;
		});
		return this.#running;
	}
}
