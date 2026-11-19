/**
 * What a session row's second line and picture say of where the session works: the repository (its picture and
 * name) and the checkout's real HEAD, a branch, a branch with no commit yet or a detached commit. The sidebar's rows
 * (this computer's and a paired computer's section, which the phone page draws too) and the work board resolve it the
 * same way, from `stores/session-targets.ts` (`shared/session-target.ts`), by `resolveRowTarget`.
 */
import { GitBranch, GitCommitHorizontal, MessageCircle, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import {
	AGENT_BRANCH_PREFIX,
	AUTOPILOT_BRANCH_PREFIX,
	type ProjectOrigin,
	type WorktreeKind,
	worktreeKindOf,
} from "../../../../shared/project-origin";
import type { SessionArtwork, SessionTarget, SessionTargetHead } from "../../../../shared/session-target";
import { useT } from "../../../lib/i18n";
import { targetKey } from "../../../stores/session-targets";
import { ProjectArtwork } from "../../common";

/** The checkout's HEAD; a detached one whose commit nothing named yet has `commit` null (a worktree git listed bare). */
export type SessionHead = SessionTargetHead | { kind: "detached"; commit: null };

export interface SessionRowTarget {
	/** The repository's name, else the folder's: the letter mark's letter and the tooltip's words. */
	name: string;
	/** The repository's picture or its owner's avatar (a `data:` URI); null draws the letter mark. */
	artwork: string | null;
	/** Null while nothing says it (no repository, git not answered). */
	head: SessionHead | null;
}

/**
 * A row's target: the answer of the computer that runs the session (`targets`, its picture from `artworks` by the
 * repository's root), else `fallback` (what this view's git origins said of the folder) until that computer answers.
 * A session whose folder is gone or unreadable keeps the folder's letter mark and no head.
 */
export function resolveRowTarget(
	maps: {
		targets: Readonly<Record<string, SessionTarget | null>>;
		artworks: Readonly<Record<string, SessionArtwork | null>>;
	},
	device: string | undefined,
	sessionPath: string,
	fallback: SessionRowTarget,
): SessionRowTarget {
	const target = maps.targets[targetKey(device, sessionPath)];
	if (target === undefined) return fallback;
	if (target === null) return { name: fallback.name, artwork: null, head: null };
	const root = target.repository?.root;
	const picture = target.artwork ?? (root ? maps.artworks[targetKey(device, root)] : null);
	return {
		name: target.repository?.name || fallback.name,
		artwork: picture?.src ?? null,
		head: target.head,
	};
}

/** A detached commit as the row writes it: its first seven characters. */
export function shortCommit(commit: string): string {
	return commit.slice(0, 7);
}

/**
 * What git already told this view of a folder (`ProjectOrigin`): the project's name and, for a linked worktree, its
 * branch (a worktree with no branch is detached). A main checkout's HEAD is not part of an origin: null.
 */
export function targetFromOrigin(origin: ProjectOrigin | null | undefined, folderName: string): SessionRowTarget {
	const worktree = origin?.worktree;
	return {
		name: origin?.project || folderName,
		artwork: null,
		head: worktree
			? worktree.branch
				? { kind: "branch", name: worktree.branch }
				: { kind: "detached", commit: null }
			: null,
	};
}

/** The head in words: what the line shows and the tooltip's whole name. */
export function headWords(
	t: (key: string, params?: Record<string, string | number>) => string,
	head: SessionHead,
): { text: string; tip: string } {
	if (head.kind === "branch") return { text: head.name, tip: t("sidebar.row.branchTip", { branch: head.name }) };
	if (head.kind === "unborn") return { text: head.name, tip: t("sidebar.row.unbornTip", { branch: head.name }) };
	if (head.commit === null) {
		const word = t("sidebar.row.detachedUnknown");
		return { text: word, tip: word };
	}
	return {
		text: t("sidebar.row.detached", { commit: shortCommit(head.commit) }),
		tip: t("sidebar.row.detachedTip", { commit: head.commit }),
	};
}

/** The worktree prefixes every agent's and Autopilot's branch shares; the row draws `…/` for them (the tooltip keeps it). */
const SHARED_PREFIXES = [AGENT_BRANCH_PREFIX, AUTOPILOT_BRANCH_PREFIX];

/**
 * What a row's line shows of a branch: past a prefix nearly every agent branch shares (`omp/agent/`, `autopilot/`) only
 * `…/` and the part that tells it from its siblings, which ends in an ellipsis on a short line. A detached head and any
 * other branch read whole.
 */
export function shownHead(text: string, head: SessionHead): string {
	if (head.kind === "detached") return text;
	const prefix = SHARED_PREFIXES.find(start => text.startsWith(start) && text.length > start.length);
	return prefix ? `…/${text.slice(prefix.length)}` : text;
}

/** The fewest characters a branch keeps in view before it goes whole (the owner's "about eight"). */
const HEAD_FLOOR_CHARS = 8;

/** Hangul, CJK and fullwidth forms: about 1.75 `ch` each in the sidebar's fonts. */
const WIDE_CHAR = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/**
 * The head's floor in `ch` when the name may be cut: its first `HEAD_FLOOR_CHARS` characters (a wide one 1.75) and 1 for
 * the ellipsis. Null for a name no longer than that: it stays whole or goes, at its own width.
 */
function headFloorCh(shown: string): number | null {
	const chars = [...shown];
	if (chars.length <= HEAD_FLOOR_CHARS) return null;
	return chars.slice(0, HEAD_FLOOR_CHARS).reduce((sum, char) => sum + (WIDE_CHAR.test(char) ? 1.75 : 1), 1);
}

/**
 * The head on a row's second line: its mark (an Autopilot branch's rocket, a branch, a commit) and its name past a
 * shared prefix (`shownHead`), which ends in an ellipsis when the line is short; the whole name is its hover title.
 * Its box (`.omp-session-head-box`, sidebar.css) drops the whole head, mark too, once the line cannot hold its mark and
 * `HEAD_FLOOR_CHARS` characters (a shorter name: all of it; one more `ch` is the ellipsis). `worktree` names what a
 * linked worktree is for (`data-sidebar-worktree`), absent for a main checkout and a run's child.
 */
export function SessionHeadLabel({ head, worktree }: { head: SessionHead; worktree?: WorktreeKind }) {
	const t = useT();
	const { text, tip } = headWords(t, head);
	const shown = shownHead(text, head);
	const floor = headFloorCh(shown);
	const Mark =
		head.kind === "detached" ? GitCommitHorizontal : worktreeKindOf(head.name) === "autopilot" ? Rocket : GitBranch;
	return (
		<span className="omp-session-head-box">
			<span aria-hidden className="omp-session-head-sentinel" />
			<span
				className="inline-flex items-center gap-1"
				data-head-whole={floor === null ? "" : undefined}
				data-session-head={head.kind}
				data-sidebar-worktree={worktree}
				style={floor === null ? undefined : { minWidth: `calc(var(--sc-icon-sm) + 0.25rem + ${floor}ch)` }}
				title={tip}
			>
				<Mark aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="min-w-0 truncate">{shown}</span>
			</span>
		</span>
	);
}

/**
 * The picture a session row leads with, spanning its two lines, `--omp-session-pic` square (sidebar.css, from the
 * row's density); a chat (no repository) shows its glyph.
 */
export function SessionRowArtwork({ target }: { target: SessionRowTarget | null }) {
	return target ? (
		<ProjectArtwork name={target.name} size="var(--omp-session-pic)" src={target.artwork} />
	) : (
		<ProjectArtwork
			icon={<MessageCircle aria-hidden className="size-(--sc-icon-md)" data-sidebar-session-icon />}
			name=""
			size="var(--omp-session-pic)"
		/>
	);
}

/**
 * A session row's second line before its controls (`data-sidebar-row-end`): the marks (✓, a missing folder, the
 * waiting badge, which goes down to its ⚠), then the age and the branch, which give way in that order on a short line
 * (the owner's order, 19 Nov 2026; sidebar.css `.omp-session-row-give`): the age goes whole first (a working arc keeps
 * its place and gives up only its hidden age), then the branch ends in an ellipsis down to about eight characters, then
 * goes with its mark, never leaving the mark alone (the tooltip keeps the name). With room, a working arc reserves the
 * age's width (composer.md › The age slot), so the branch stays where it was when work starts or ends.
 */
export function SessionRowLine({
	marks,
	age,
	head,
	worktree,
}: {
	marks?: ReactNode;
	age?: ReactNode;
	head: SessionHead | null;
	worktree?: WorktreeKind;
}) {
	return (
		<span className="omp-session-row-line" data-sidebar-row-end>
			{marks}
			<span className="omp-session-row-give">
				{/* Row-reversed: the branch is laid out first and the age wraps out of sight before it. */}
				{head && <SessionHeadLabel head={head} worktree={worktree} />}
				{age && (
					<span className="omp-session-row-age" data-session-row-age>
						{age}
					</span>
				)}
			</span>
		</span>
	);
}

/** The second line's controls (the family chip, the one ⋯), raised above the row's click target. */
export function SessionRowEnd({ children }: { children: ReactNode }) {
	return <span className="relative z-(--sc-z-raised) flex shrink-0 items-center gap-0.5">{children}</span>;
}
