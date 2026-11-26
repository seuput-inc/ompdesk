/**
 * Session search ranking, shared by the session picker and the sidebar.
 * Mirrors the TUI session-selector (`rankSessionSearchMatches`): multi-token
 * queries, literal substring matches first (recency/alpha order), then
 * subsequence fuzzy matches ranked by score. Full-transcript hits from the
 * main-process content grep are merged in after metadata matches.
 *
 * `repo:` and `path:` narrow the list (after Orca's ai-vault search operators,
 * stablyai/orca `shared/ai-vault/search/ai-vault-search-query-operators.ts`, MIT;
 * re-implemented): every operator must match, case folded, `repo:` against the
 * session's project, `path:` against its folder and file.
 */

import type { SessionInfo } from "../../shared/ipc-types";
import { fuzzyScore } from "./fuzzy-score";

export type SessionSortMode = "recent" | "alpha";

/** A query split into its free text and its operators. */
export interface SessionQuery {
	/** The query without operator tokens, quotes kept: what ranking and the content grep see. */
	text: string;
	/** `repo:` values, lowercased. */
	repo: readonly string[];
	/** `path:` values, lowercased. */
	path: readonly string[];
}

/** Anchored at a token start only, so `myrepo:x` and `https://h/path:x` stay literal. */
const OPERATOR = /(repo|path):/iy;

/** Split `repo:` and `path:` tokens (bare or quoted values) off a search query. */
export function splitSessionQuery(query: string): SessionQuery {
	const spans: string[] = [];
	const repo: string[] = [];
	const path: string[] = [];
	let index = 0;
	while (index < query.length) {
		if (/\s/.test(query[index] ?? "")) {
			index++;
			continue;
		}
		OPERATOR.lastIndex = index;
		const operator = OPERATOR.exec(query);
		const at = operator ? index + operator[0].length : index;
		const quoted = readQuoted(query, at);
		const value = quoted?.value ?? readBare(query, at);
		const end = quoted ? quoted.end : at + value.length;
		if (operator) {
			const operand = value.trim().toLowerCase();
			if (operand) (operator[1]?.toLowerCase() === "repo" ? repo : path).push(operand);
		} else spans.push(query.slice(index, end));
		index = end;
	}
	return { text: spans.join(" "), repo, path };
}

function readQuoted(query: string, at: number): { value: string; end: number } | null {
	const quote = query[at];
	if (quote !== '"' && quote !== "'") return null;
	const close = query.indexOf(quote, at + 1);
	return close === -1 ? null : { value: query.slice(at + 1, close), end: close + 1 };
}

function readBare(query: string, at: number): string {
	let end = at;
	while (end < query.length && !/\s/.test(query[end] ?? "")) end++;
	return query.slice(at, end);
}

/** Whether a session passes every operator of a query. `repoOf` names its project (default: its folder's tail). */
export function matchesSessionOperators(
	session: Pick<SessionInfo, "cwd" | "path">,
	query: Pick<SessionQuery, "repo" | "path">,
	// A session's project when the caller knows no better name: its folder's last two segments.
	repoOf: (session: Pick<SessionInfo, "cwd">) => string = session =>
		session.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/"),
): boolean {
	if (query.repo.length > 0) {
		const repo = repoOf(session).toLowerCase();
		if (query.repo.some(term => !repo.includes(term))) return false;
	}
	if (query.path.length > 0) {
		const where = `${session.cwd} ${session.path}`.toLowerCase();
		if (query.path.some(term => !where.includes(term))) return false;
	}
	return true;
}

/** Lowercased per-session haystack, built once per listing via WeakMap. */
const haystacks = new WeakMap<SessionInfo, string>();

function haystack(session: SessionInfo): string {
	let text = haystacks.get(session);
	if (text === undefined) {
		text =
			`${session.title ?? ""} ${session.autoTitle ?? ""} ${session.firstMessage} ${session.cwd} ${session.id}`.toLowerCase();
		haystacks.set(session, text);
	}
	return text;
}

function compareRecency(a: SessionInfo, b: SessionInfo): number {
	return Date.parse(b.modified) - Date.parse(a.modified);
}

function compareAlpha(a: SessionInfo, b: SessionInfo): number {
	return (
		(a.title ?? a.firstMessage).localeCompare(b.title ?? b.firstMessage, undefined, { sensitivity: "base" }) ||
		compareRecency(a, b)
	);
}

/**
 * Filter and rank sessions for a query. Literal matches (every token present
 * verbatim) rank purely by the active sort; pure fuzzy/acronym matches follow,
 * ranked by score. An empty query returns the full list in sort order. `repo:`
 * and `path:` tokens filter before ranking (`repoOf` names a session's project).
 */
export function rankSessions(
	sessions: SessionInfo[],
	query: string,
	sort: SessionSortMode = "recent",
	repoOf?: (session: Pick<SessionInfo, "cwd">) => string,
): SessionInfo[] {
	const tiebreak = sort === "alpha" ? compareAlpha : compareRecency;
	const split = splitSessionQuery(query);
	const pool =
		split.repo.length + split.path.length === 0
			? sessions
			: sessions.filter(session => matchesSessionOperators(session, split, repoOf));
	const tokens = split.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return [...pool].sort(tiebreak);

	const literal: { session: SessionInfo; index: number }[] = [];
	const fuzzy: { session: SessionInfo; score: number; index: number }[] = [];
	pool.forEach((session, index) => {
		const text = haystack(session);
		if (tokens.every(token => text.includes(token))) {
			literal.push({ session, index });
			return;
		}
		let score = 0;
		for (const token of tokens) {
			const tokenScore = fuzzyScore(token, text);
			if (tokenScore === null) return;
			score += tokenScore;
		}
		fuzzy.push({ session, score, index });
	});

	literal.sort((a, b) => tiebreak(a.session, b.session) || a.index - b.index);
	fuzzy.sort((a, b) => b.score - a.score || tiebreak(a.session, b.session) || a.index - b.index);
	return [...literal.map(match => match.session), ...fuzzy.map(match => match.session)];
}

/**
 * Append full-transcript content hits after the metadata-ranked matches.
 * Content hit paths come from the main-process `sessions:search` grep; a
 * session already matched on metadata is never duplicated.
 */
export function mergeContentMatches(
	ranked: SessionInfo[],
	sessions: SessionInfo[],
	contentPaths: Pick<ReadonlySet<string>, "has" | "size">,
): SessionInfo[] {
	if (contentPaths.size === 0) return ranked;
	const seen = new Set(ranked.map(session => session.path));
	const extra = sessions.filter(session => contentPaths.has(session.path) && !seen.has(session.path));
	return extra.length === 0 ? ranked : [...ranked, ...extra];
}
