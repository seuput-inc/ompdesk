/**
 * The rules omp-latest.yml follows the verified-omp list by (src/shared/omp-compat.ts): which targets an hourly run
 * tests (the newest release's tag, main, or nothing), and the list's text after a verdict. The git and CLI side is
 * compat.ts; the bump path of the main target is latest-run.ts.
 */
import {
	type CompatVerdict,
	compatEntry,
	compatPending,
	isExactVersion,
	OMP_COMPAT_BRANCH,
	OMP_COMPAT_FILE,
	type OmpCompatList,
	parseOmpCompat,
	recordVerdict,
} from "../../src/shared/omp-compat";
import { compareVersions } from "../../src/shared/version";

/**
 * The `on.schedule` entry of omp-latest.yml that is the daily slot (`github.event.schedule` names the entry that
 * started a run). The clock is not asked: a scheduled run can start an hour late.
 */
export const DAILY_CRON = "47 4 * * *";

const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

/** The versions of the release tags among `tags` (`vX.Y.Z` only), oldest first. */
export function releaseVersions(tags: readonly string[]): string[] {
	return tags
		.map(tag => RELEASE_TAG.exec(tag)?.[1])
		.filter(isExactVersion)
		.sort((a, b) => compareVersions(a, b) ?? 0);
}

export interface TargetsInput {
	/** A `workflow_dispatch` run; otherwise the schedule's. */
	dispatch: boolean;
	/** The schedule's daily slot. */
	daily: boolean;
	/** A dispatch's `recheck`: verify again whatever the list says. */
	recheck: boolean;
	/** A dispatch's `rehearse_app`, or empty: this release stands in for the newest one, and nothing is written. */
	rehearseApp: string;
	onMain: boolean;
	/** npm's newest omp. */
	latest: string;
	/** The tags of the published releases (no draft, no prerelease). */
	releases: readonly string[];
	list: OmpCompatList;
}

export interface Targets {
	/** The OMPdesk release the release target checks out as `v<app>`; empty while the repository has none. */
	app: string;
	/** Test `latest` against `v<app>`'s code. */
	release: boolean;
	/** Test `latest` against this ref's code (the old daily run, and its bump path on main). */
	main: boolean;
	/** The release target's verdict goes into the list and its issue: only on main, never in a rehearsal. */
	write: boolean;
	why: string;
}

export function planTargets(input: TargetsInput): Targets {
	if (!isExactVersion(input.latest))
		throw new Error(`latest omp version is not X.Y.Z: ${JSON.stringify(input.latest)}`);
	const released = releaseVersions(input.releases);
	if (input.rehearseApp !== "" && !released.includes(input.rehearseApp)) {
		throw new Error(`rehearse_app is not a published release (vX.Y.Z): ${JSON.stringify(input.rehearseApp)}`);
	}
	const app = input.rehearseApp || released.at(-1) || "";
	const reason = app === "" ? null : releaseReason(input, app);
	const release = reason !== null;
	return {
		app,
		release,
		main: input.dispatch || input.daily || release,
		write: input.onMain && input.rehearseApp === "",
		why:
			reason ??
			(app === ""
				? "no published release to verify against"
				: `omp ${input.latest} already has its verdict for OMPdesk ${app}`),
	};
}

/** Why this run tests `latest` against `app`'s code, or null when it does not. */
function releaseReason(input: TargetsInput, app: string): string | null {
	const pair = `omp ${input.latest} against OMPdesk ${app}`;
	if (input.rehearseApp !== "") return `rehearsal of ${pair}`;
	if (compatPending(input.list, app, input.latest)) return `${pair} has no verdict yet`;
	if (input.dispatch && input.recheck) return `recheck of ${pair}`;
	if (input.daily && compatEntry(input.list, app).holding?.version === input.latest) {
		return `daily retry of ${pair}, held`;
	}
	return null;
}

export function holdIssueTitle(omp: string, app: string): string {
	return `omp ${omp} fails against OMPdesk ${app}`;
}

/** The list as the branch's file holds it; refuses a list the app's strict reader would not take back as written. */
export function serializeCompat(list: OmpCompatList): string {
	const text = `${JSON.stringify(list, null, "\t")}\n`;
	const back = parseOmpCompat(text);
	if (!back || JSON.stringify(back) !== JSON.stringify(list)) {
		throw new Error(`refusing to write a ${OMP_COMPAT_FILE} that parseOmpCompat does not read back:\n${text}`);
	}
	return text;
}

export interface Applied {
	list: OmpCompatList;
	text: string;
	/** Whether `text` differs from the file read; a verdict the list already holds changes nothing. */
	changed: boolean;
	/** The issue of the hold a green verdict let go of, when the list knew one. */
	releasedIssue: number | null;
}

/** The file after `verdict`. `current` is the file's text as read from the branch, null when branch or file is missing. */
export function applyVerdict(current: string | null, app: string, omp: string, verdict: CompatVerdict): Applied {
	const before: OmpCompatList | null = current === null ? {} : parseOmpCompat(current);
	if (!before) {
		throw new Error(
			`${OMP_COMPAT_FILE} on ${OMP_COMPAT_BRANCH} is not a verified-omp list; fix or delete it by hand`,
		);
	}
	const list = recordVerdict(before, app, omp, verdict);
	const text = serializeCompat(list);
	const held = compatEntry(before, app).holding;
	return {
		list,
		text,
		changed: text !== current,
		releasedIssue: held && !compatEntry(list, app).holding ? held.issue : null,
	};
}
