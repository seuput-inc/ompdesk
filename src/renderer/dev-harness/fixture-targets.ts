/**
 * What the harness's sessions work in (`shared/session-target.ts`), as main's `sessions.targets` / `sessions.artwork`
 * would answer for this computer or a paired host: every kind of row the two-line session row draws. The ompdesk
 * project has a picture and its sessions sit on `main` and on a long agent branch; the website project has none (its
 * letter mark) and sits on a detached HEAD; `?rows=N`'s saved sessions cycle through an unborn branch, a branch and a
 * folder in no repository.
 */
import type { SessionArtworks, SessionTarget, SessionTargetQuery, SessionTargets } from "../../shared/session-target";
import { PROJECT } from "./fixture";

const WEBSITE = "/Users/dev/projects/website";

/** A small square picture standing in for a repository's logo (main sends a PNG; any image `data:` URL draws). */
const LOGO = `data:image/svg+xml;base64,${btoa(
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#111827"/><path d="M14 20h36v6H42v24h-7V26h-6v18a6 6 0 0 1-6 6h-3v-6h2V26h-8z" fill="#f59e0b"/></svg>',
)}`;

const repo = (root: string) => ({ root, name: root.split("/").pop() ?? root, owner: "seuput-inc" });

function targetOf({ sessionPath, cwd }: SessionTargetQuery): SessionTarget {
	if (sessionPath.includes("sess-1"))
		return { path: cwd, repository: repo(PROJECT), head: { kind: "branch", name: "main" } };
	if (sessionPath.includes("sess-2"))
		return {
			path: cwd,
			repository: repo(PROJECT),
			head: { kind: "branch", name: "omp/agent/settings-dark-mode-follows-the-system-theme-20261119" },
		};
	if (sessionPath.includes("sess-3"))
		return {
			path: cwd,
			repository: repo(WEBSITE),
			head: { kind: "detached", commit: "9f3c2a1b7e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b" },
			artwork: null,
		};
	const index = Number(sessionPath.match(/sess-row-(\d+)/)?.[1] ?? 0);
	switch (index % 3) {
		case 0:
			return { path: cwd, repository: null, head: null };
		case 1:
			return { path: cwd, repository: repo(PROJECT), head: { kind: "unborn", name: "main" } };
		default:
			return { path: cwd, repository: repo(PROJECT), head: { kind: "branch", name: `fix/row-${index}` } };
	}
}

export function targetsFixture(queries: readonly SessionTargetQuery[]): SessionTargets {
	return Object.fromEntries(queries.map(query => [query.sessionPath, targetOf(query)]));
}

export function artworkFixture(roots: readonly string[]): SessionArtworks {
	return Object.fromEntries(roots.map(root => [root, root === PROJECT ? { src: LOGO, source: "repository" } : null]));
}
