/**
 * Resume-session picker: searchable list of on-disk sessions. Search mirrors
 * the TUI session-selector — literal matches first (recency order), then
 * subsequence fuzzy matches over title/firstMessage/cwd, then full-transcript
 * content hits from the main-process session-file grep. Scope toggles between
 * this folder and all projects (TUI Tab parity); sort and path display are
 * user options. Selection calls rpc.switchSession and rehydrates the renderer
 * stores. Follows the ModelPicker overlay pattern.
 */

import {
	ArrowDownAZ,
	Check,
	Clock,
	Folder,
	FolderTree,
	Globe,
	History,
	MessageCircle,
	Plus,
	RotateCw,
} from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { opensInOwnTab, requestSessionSwitch, switchSessionNow } from "../../hooks/use-session-switch";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { formatTimeAgo, shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import { useProjectNames } from "../../lib/project-origin";
import { laneState } from "../../lib/session-lane";
import { sessionRun } from "../../lib/session-run";
import {
	matchesSessionOperators,
	mergeContentMatches,
	rankSessions,
	type SessionSortMode,
	splitSessionQuery,
} from "../../lib/session-search";
import { sessionDisplayParts, sessionHasContent } from "../../lib/session-title";
import { useSummaryMap } from "../../stores/hosted-sessions";
import { useSessionStore } from "../../stores/session";
import { sessionListFeed } from "../../stores/session-list";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Button,
	Chip,
	EmptyState,
	IconButton,
	InlineNotice,
	Kbd,
	Modal,
	OptionGroup,
	OptionRow,
	SearchField,
	SessionTitle,
	SkeletonRows,
	Spinner,
	Tooltip,
} from "../common";
import { SessionStatusLane } from "../layout/sidebar/SessionStatusLane";

type SessionScope = "local" | "global";
/** What a session is doing, as a chip narrows the list: it waits on the person, it works, a tab here holds it. */
type StateChip = "needs" | "working" | "open";

/** Delay before the main-process content grep is consulted for the current query. */
const CONTENT_SEARCH_DEBOUNCE_MS = 200;
/** Minimum query length for content augmentation (single characters match everything). */
const CONTENT_SEARCH_MIN_QUERY = 2;
/** Project chips offered at most, the busiest first. */
const PROJECT_CHIPS = 6;

export function SessionPickerDialog() {
	const t = useT();
	const open = useUiStore(state => state.sessionPickerOpen);
	const close = useUiStore(state => state.closeSessionPicker);
	const sessionId = useSessionStore(state => state.sessionId);

	const [query, setQuery] = useState("");
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [scope, setScope] = useState<SessionScope>("global");
	const [sortMode, setSortMode] = useState<SessionSortMode>("recent");
	// null = follow the scope default (paths shown in all-projects scope).
	const [showPath, setShowPath] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(false);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	/** Transcript-only hits from the main-process grep: path → excerpt of the matching text. */
	const [contentHits, setContentHits] = useState<ReadonlyMap<string, string | undefined>>(new Map());
	const [contentPending, setContentPending] = useState(false);
	const [stateChips, setStateChips] = useState<readonly StateChip[]>([]);
	const [projectChips, setProjectChips] = useState<readonly string[]>([]);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	// Per-scope listings cached for the dialog's lifetime so toggling is instant.
	const listsRef = useRef<{ local?: SessionInfo[]; global?: SessionInfo[] }>({});
	const searchGenerationRef = useRef(0);

	const effectiveShowPath = showPath ?? scope === "global";

	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs; nothing inside
	   reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setScope("global");
		setSortMode("recent");
		setShowPath(null);
		setStateChips([]);
		setProjectChips([]);
		// The sidebar's list (or the last run's snapshot of it) fills the dialog at once; the read below replaces it.
		const known = sessionListFeed("global").store.getState().sessions.filter(sessionHasContent);
		setSessions(known);
		setLoading(known.length === 0);
		setError(null);
		setSwitching(null);
		setActiveIndex(0);
		setContentHits(new Map());
		setContentPending(false);
		searchGenerationRef.current++;
		listsRef.current = {};
		requestAnimationFrame(() => inputRef.current?.focus());
		let cancelled = false;
		void (async () => {
			try {
				// A header-only file (stock `new_session` writes one at once) is not a conversation: stock's
				// own picker drops it too (`filterSessionsForPicker`), and so does the sidebar.
				const global = (await window.omp.sessions.list("global")).filter(sessionHasContent);
				if (cancelled) return;
				listsRef.current.global = global;
				setSessions(global);
				setScope("global");
			} catch (cause) {
				if (!cancelled) setError(inlineFailure(cause, t("sessionPicker.loadFailed")));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [attempt, open]);

	const switchScope = async (target: SessionScope) => {
		if (target === scope || loading) return;
		setLoading(true);
		setError(null);
		setActiveIndex(0);
		try {
			const list = listsRef.current[target] ?? (await window.omp.sessions.list(target)).filter(sessionHasContent);
			listsRef.current[target] = list;
			setSessions(list);
			setScope(target);
		} catch (cause) {
			setError(inlineFailure(cause, t("sessionPicker.loadFailed")));
		} finally {
			setLoading(false);
		}
	};

	// Debounced full-transcript content search (main-process grep over the
	// session files) for the query's free text; `repo:`/`path:` narrow its hits
	// below. Best-effort: failures simply yield no content matches.
	const contentQuery = splitSessionQuery(query).text.trim();
	useEffect(() => {
		const q = contentQuery;
		if (q.length < CONTENT_SEARCH_MIN_QUERY) {
			setContentHits(new Map());
			setContentPending(false);
			return;
		}
		const generation = ++searchGenerationRef.current;
		const timer = setTimeout(() => {
			setContentPending(true);
			window.omp.sessions
				.search(q, scope)
				.then(hits => {
					if (searchGenerationRef.current === generation)
						setContentHits(new Map(hits.map(hit => [hit.path, hit.snippet])));
				})
				.catch(() => {})
				.finally(() => {
					if (searchGenerationRef.current === generation) setContentPending(false);
				});
		}, CONTENT_SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [contentQuery, scope]);

	const projectNameOf = useProjectNames(
		useMemo(() => (open ? sessions.map(session => session.cwd) : []), [open, sessions]),
	);
	const { filtered, contentOnly } = useMemo(() => {
		// `repo:` reads the project as the row names it and its main checkout's folder.
		const repoOf = ({ cwd }: Pick<SessionInfo, "cwd">) => {
			const project = projectNameOf(cwd);
			return `${project.name} ${project.root}`;
		};
		const split = splitSessionQuery(query);
		const ranked = rankSessions(sessions, query, sortMode, repoOf);
		const merged = mergeContentMatches(
			ranked,
			sessions.filter(session => matchesSessionOperators(session, split, repoOf)),
			contentHits,
		);
		const metaPaths = new Set(ranked.map(session => session.path));
		const only = new Set<string>();
		for (const session of merged) {
			if (!metaPaths.has(session.path)) only.add(session.path);
		}
		return { filtered: merged, contentOnly: only };
	}, [sessions, query, sortMode, contentHits, projectNameOf]);

	// The chips (Orca's ⌘J filter chips): what a session is doing, by its computer's summary, and its project; and the
	// sessions a tab of this window holds listed first, as their own group (Orca's open-tab results).
	const tabs = useTabsStore(state => state.tabs);
	const summaries = useSummaryMap(undefined);
	const projects = useMemo(() => {
		const counts = new Map<string, number>();
		for (const session of sessions) {
			const name = projectNameOf(session.cwd).name;
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		return [...counts]
			.sort((a, b) => b[1] - a[1])
			.slice(0, PROJECT_CHIPS)
			.map(([name]) => name);
	}, [sessions, projectNameOf]);
	const { held, rest } = useMemo(() => {
		const tabOf = (session: SessionInfo) =>
			tabs.find(tab => tab.device === undefined && tab.sessionPath === session.path);
		const passes = filtered.filter(session => {
			if (projectChips.length > 0 && !projectChips.includes(projectNameOf(session.cwd).name)) return false;
			if (stateChips.length === 0) return true;
			const tab = tabOf(session);
			const run = sessionRun(summaries.get(session.path), tab?.unreadDone === true);
			return stateChips.some(chip => (chip === "needs" ? run.waiting : chip === "working" ? run.running : !!tab));
		});
		return { held: passes.filter(session => tabOf(session)), rest: passes.filter(session => !tabOf(session)) };
	}, [filtered, tabs, summaries, stateChips, projectChips, projectNameOf]);
	const listed = useMemo(() => [...held, ...rest], [held, rest]);
	// A name typed that no session answers can start a worktree (Orca's create row): its own last option.
	const createName = query.trim() ? splitSessionQuery(query).text.trim() : "";
	const optionCount = listed.length + (createName ? 1 : 0);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, optionCount - 1)));
	}, [optionCount]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const select = async (session: SessionInfo) => {
		if (switching !== null) return;
		// Busy sessions route to the switch dialog (new window vs abort) — close
		// the picker first so it doesn't sit behind the modal. A session of another folder opens as its own tab and
		// aborts nothing.
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if ((isStreaming || isCompacting) && !opensInOwnTab(session)) {
			close();
			requestSessionSwitch(session);
			return;
		}
		setSwitching(session.path);
		try {
			if (await switchSessionNow(session)) close();
		} finally {
			setSwitching(null);
		}
	};
	const createWorktree = () => {
		close();
		useUiStore.getState().openWorktreeDialog({ name: createName });
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		const target = listboxTarget(event.key, activeIndex, optionCount, { wrap: false });
		if (target !== null) {
			event.preventDefault();
			setActiveIndex(target);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const session = listed[activeIndex];
			if (session) void select(session);
			else if (createName && activeIndex === listed.length) createWorktree();
		}
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && optionCount > 0;
	const toggle = <T extends string>(values: readonly T[], value: T): T[] =>
		values.includes(value) ? values.filter(candidate => candidate !== value) : [...values, value];

	const renderRow = (session: SessionInfo, index: number) => {
		const snippet = contentOnly.has(session.path) ? contentHits.get(session.path) : undefined;
		const isCurrent = session.id === sessionId;
		const isActive = index === activeIndex;
		// A blank stored title falls back like the sidebar's, never to an empty row.
		const titleParts = sessionDisplayParts(session, t("sessionPicker.untitled"));
		const tab = tabs.find(candidate => candidate.device === undefined && candidate.sessionPath === session.path);
		const run = sessionRun(summaries.get(session.path), tab?.unreadDone === true);
		return (
			<OptionRow
				active={isActive}
				selected={isCurrent}
				data-option-index={index}
				disabled={switching !== null}
				id={`${listboxId}-option-${index}`}
				key={session.path}
				onClick={() => void select(session)}
				onMouseEnter={() => setActiveIndex(index)}
			>
				{run.signal ? (
					<span className="shrink-0" title={t(run.signal.labelKey)}>
						<SessionStatusLane
							state={laneState({
								run,
								attention: run.ask,
								live: run.running ? "turn" : null,
								stopped: false,
								pullRequest: false,
								open: tab !== undefined,
							})}
						/>
					</span>
				) : (
					<History aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				)}
				{session.kind === "chat" && (
					<MessageCircle
						className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)"
						aria-label={t("tabs.kind.chat")}
					/>
				)}
				<span className="min-w-0 flex-1">
					<SessionTitle
						className="text-sc-md"
						parts={titleParts}
						titleClassName={`text-(--sc-text) ${isCurrent ? "font-semibold" : "font-medium"}`}
					/>
					<span className="block truncate text-sc-xs text-(--sc-text-muted)">
						{run.signal && <span className="sr-only">{t(run.signal.labelKey)}, </span>}
						{effectiveShowPath && session.cwd
							? shortenPath(session.cwd)
							: projectNameOf(session.cwd, session.title).name}{" "}
						· {t("sessionPicker.messageCount", { count: session.messageCount })} ·{" "}
						{formatTimeAgo(session.modified)}
					</span>
					{snippet && (
						<span className="mt-0.5 block truncate text-sc-xs text-(--sc-text-secondary)">{snippet}</span>
					)}
				</span>
				{projectNameOf(session.cwd, session.title).gone && (
					<Tooltip content={t("sessionFolder.goneTip")}>
						<span className="shrink-0" data-session-folder-gone>
							<Badge variant="warning">{t("sessionFolder.gone")}</Badge>
						</span>
					</Tooltip>
				)}
				{contentOnly.has(session.path) && (
					<Badge className="shrink-0" variant="info">
						{t("sessionPicker.contentMatch")}
					</Badge>
				)}
				{switching === session.path && <Spinner size="sm" spin />}
				{isCurrent && <Check aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)" />}
			</OptionRow>
		);
	};

	return (
		<Modal
			ariaLabel={t("sessionPicker.searchLabel")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					<div className="min-w-0 flex-1">
						<SearchField
							listbox={{
								id: listboxId,
								activeId: optionCount > 0 ? `${listboxId}-option-${activeIndex}` : undefined,
							}}
							controlSize="lg"
							label={t("sessionPicker.searchLabel")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("sessionPicker.placeholder")}
							ref={inputRef}
							value={query}
						/>
					</div>
					<IconButton
						icon={scope === "local" ? <Folder /> : <Globe />}
						label={scope === "local" ? t("sessionPicker.scopeToGlobal") : t("sessionPicker.scopeToLocal")}
						onClick={() => void switchScope(scope === "local" ? "global" : "local")}
						pressed={scope === "global"}
					/>
					<IconButton
						icon={sortMode === "recent" ? <Clock /> : <ArrowDownAZ />}
						label={sortMode === "recent" ? t("sessionPicker.sortAlpha") : t("sessionPicker.sortRecent")}
						onClick={() => setSortMode(mode => (mode === "recent" ? "alpha" : "recent"))}
					/>
					<IconButton
						icon={<FolderTree />}
						label={effectiveShowPath ? t("sessionPicker.hidePaths") : t("sessionPicker.showPaths")}
						onClick={() => setShowPath(!effectiveShowPath)}
						pressed={effectiveShowPath}
					/>
					<Kbd shortcut="⎋" />
				</div>
				<div
					className="flex flex-wrap items-center gap-1 border-b border-(--sc-divider) px-4 py-2 [--hit-gap-x:2px] [--hit-gap-y:2px]"
					data-session-picker-chips
				>
					{(["needs", "working", "open"] as const).map(chip => (
						<Chip
							data-session-picker-chip={chip}
							key={chip}
							onPressedChange={() => setStateChips(current => toggle(current, chip))}
							pressed={stateChips.includes(chip)}
						>
							{t(`sessionPicker.chip.${chip}`)}
						</Chip>
					))}
					{projects.map(name => (
						<Chip
							data-session-picker-chip="project"
							key={`project:${name}`}
							onPressedChange={() => setProjectChips(current => toggle(current, name))}
							pressed={projectChips.includes(name)}
						>
							{name}
						</Chip>
					))}
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<InlineNotice
							action={
								<Button
									icon={<RotateCw />}
									onClick={() => setAttempt(count => count + 1)}
									size="sm"
									variant="secondary"
								>
									{t("common.retry")}
								</Button>
							}
							className="px-3 py-6"
							detail={error.cause}
							live
							title={error.message}
							tone="danger"
						/>
					) : loading ? (
						<SkeletonRows className="py-3" label={t("sessionPicker.loading")} widths={[70, 52, 64, 46, 58]} />
					) : (
						<>
							{listed.length === 0 && !contentPending && (
								<EmptyState
									size="sm"
									title={
										sessions.length === 0
											? scope === "local"
												? t("sessionPicker.emptyLocal")
												: t("sessionPicker.empty")
											: t("sessionPicker.noMatch", { query })
									}
								/>
							)}
							{held.length > 0 ? (
								<>
									<OptionGroup
										count={held.length}
										data-session-picker-open
										label={t("sessionPicker.group.open")}
									>
										{held.map((session, index) => renderRow(session, index))}
									</OptionGroup>
									{rest.length > 0 && (
										<OptionGroup count={rest.length} label={t("sessionPicker.group.other")}>
											{rest.map((session, index) => renderRow(session, held.length + index))}
										</OptionGroup>
									)}
								</>
							) : (
								rest.map((session, index) => renderRow(session, index))
							)}
							{createName && (
								<OptionRow
									active={activeIndex === listed.length}
									data-option-index={listed.length}
									data-session-picker-create
									id={`${listboxId}-option-${listed.length}`}
									onClick={createWorktree}
									onMouseEnter={() => setActiveIndex(listed.length)}
								>
									<Plus aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0 flex-1 truncate text-sc-md">
										{t("sessionPicker.createWorktree", { name: createName })}
									</span>
								</OptionRow>
							)}
						</>
					)}
					{contentPending && !error && !loading && (
						<Spinner
							className="w-full justify-center py-3"
							label={t("sessionPicker.searchingContent")}
							size="sm"
						/>
					)}
				</div>
			</div>
		</Modal>
	);
}
