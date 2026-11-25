/**
 * What a session row's second line and picture say of where the session works: the repository (its picture and
 * name) and the checkout's real HEAD, a branch, a branch with no commit yet or a detached commit. The sidebar's rows
 * (this computer's and a paired computer's section, which the phone page draws too) and the work board resolve it the
 * same way, from `stores/session-targets.ts` (`shared/session-target.ts`), by `resolveRowTarget`.
 */
import { GitBranch, GitCommitHorizontal, MessageCircle, Rocket } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
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
 * `…/` and the part that tells it from its siblings. A detached head and any other branch read whole.
 */
export function shownHead(text: string, head: SessionHead): string {
	if (head.kind === "detached") return text;
	const prefix = SHARED_PREFIXES.find(start => text.startsWith(start) && text.length > start.length);
	return prefix ? `…/${text.slice(prefix.length)}` : text;
}

/** The fewest characters a branch keeps in view before it goes whole (the owner's "about eight"). */
const HEAD_FLOOR_CHARS = 8;

/** The longest last segment (its separator included) a cut name keeps whole; a date stamp's is longer and goes. */
const HEAD_TAIL_MAX = 8;

/**
 * How a name gives way on a short line: the middle goes (the owner's "keep the distinguishing tail", 19 Nov 2026), so
 * `…/settings-panel-dark` and `…/settings-panel-light` read `…/settings-pa…-dark` and `…-light`. `body` ends in the
 * ellipsis, `tail` (the last `-`, `_` or `/` segment with its separator, at most `HEAD_TAIL_MAX`) never shrinks; a name
 * with no such tail ends in the ellipsis. `floor` is the text the head keeps before it goes whole (about
 * `HEAD_FLOOR_CHARS` characters with the tail, and the ellipsis); null for a name no longer than that, which stays
 * whole or goes at its own width.
 */
export function headParts(shown: string): { body: string; tail: string; floor: string | null } {
	const chars = [...shown];
	if (chars.length <= HEAD_FLOOR_CHARS) return { body: shown, tail: "", floor: null };
	const cut = Math.max(shown.lastIndexOf("-"), shown.lastIndexOf("_"), shown.lastIndexOf("/"));
	const tail = cut > 2 && shown.length - cut <= HEAD_TAIL_MAX ? shown.slice(cut) : "";
	const body = tail ? shown.slice(0, cut) : shown;
	const kept = [...body].slice(0, Math.max(3, HEAD_FLOOR_CHARS - [...tail].length)).join("");
	return { body, tail, floor: `${kept}…${tail}` };
}

let measureContext: CanvasRenderingContext2D | null | undefined;

/** The width of `text` in `font`, by a canvas's text metrics (no layout); null where there is no canvas. */
function textWidth(font: string, text: string): number | null {
	if (measureContext === undefined)
		measureContext =
			typeof document === "undefined" ? null : (document.createElement("canvas").getContext?.("2d") ?? null);
	if (!measureContext) return null;
	measureContext.font = font;
	return measureContext.measureText(text).width;
}

/**
 * The head on a row's second line: its mark (an Autopilot branch's rocket, a branch, a commit) and its name past a
 * shared prefix (`shownHead`), whose middle gives way on a short line (`headParts`: the last segment stays); the whole
 * name is its hover title. Its box (`.omp-session-head-box`, sidebar.css) drops the whole head, mark too, once the line
 * cannot hold its mark and the name's floor, measured in the name's own font before the first paint and laid out as the
 * head's flex basis and minimum (a minimum alone did not wrap it in the Windows runners' Chromium). `worktree` names
 * what a linked worktree is for (`data-sidebar-worktree`), absent for a main checkout and a run's child.
 */
export function SessionHeadLabel({ head, worktree }: { head: SessionHead; worktree?: WorktreeKind }) {
	const t = useT();
	const { text, tip } = headWords(t, head);
	const { body, tail, floor } = headParts(shownHead(text, head));
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		const name = element?.querySelector(".truncate");
		if (!element || !name) return;
		const style = floor === null ? null : name.ownerDocument.defaultView?.getComputedStyle?.(name);
		const width =
			floor === null || !style
				? null
				: textWidth(style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, floor);
		const size = width === null ? "" : `calc(var(--sc-icon-sm) + 0.25rem + ${Math.ceil(width) + 1}px)`;
		element.style.flexBasis = size;
		element.style.minWidth = size;
	}, [floor]);
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
				ref={ref}
				title={tip}
			>
				<Mark aria-hidden className="size-(--sc-icon-sm) shrink-0" />
				<span className="flex min-w-0">
					<span className="min-w-0 truncate">{body}</span>
					{tail && (
						<span className="shrink-0 whitespace-nowrap" data-head-tail>
							{tail}
						</span>
					)}
				</span>
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
 * A session row's second line before its controls (`data-sidebar-row-end`): the marks (a pin or fork, a missing
 * folder, the waiting badge, which goes down to its ⚠), then the age and the branch, which give way in that order on a
 * short line (the owner's order, 19 Nov 2026; sidebar.css `.omp-session-row-give`): the age goes whole first, then the
 * branch ends in an ellipsis down to about eight characters, then goes with its mark, never leaving the mark alone (the
 * tooltip keeps the name). Work under way and an unseen finish are the row's leading status lane, not this line, so the
 * branch never moves when work starts or ends.
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
