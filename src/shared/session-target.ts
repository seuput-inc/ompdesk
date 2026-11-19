/**
 * What a session works in, as the computer that runs it resolved it: the real repository (its main checkout, also
 * for a session in one of its worktrees), the checkout's own HEAD and the repository's image. Every view reads it the
 * same way (this computer's windows, a paired computer's view of a host's sessions, the phone page), keyed by session
 * file, through `sessions.targets` and, for the image, `sessions.artwork`. Dependency-free: main, the renderer and
 * the paired link share it.
 *
 * A session row draws from it: the image (else a letter mark of `repository.name`, else of the folder's name), the
 * branch on its second line, and the work panel the same branch.
 */

/** The checkout's HEAD: a worktree reads its own branch, never the main checkout's. */
export type SessionTargetHead =
	| { kind: "branch"; name: string }
	/** A detached HEAD: the full commit id (a row shows its first 7). */
	| { kind: "detached"; commit: string }
	/** A branch with no commit yet (a fresh `git init`). */
	| { kind: "unborn"; name: string };

/**
 * Where the image came from: the repository's own file (favicon, logo, social preview), its homepage's icon, or
 * its GitHub owner's avatar. The first two are the repository's own image.
 */
export type SessionArtworkSource = "repository" | "homepage" | "owner";

export interface SessionArtwork {
	/** A small PNG as a `data:image/png;base64,…` URL: it loads the same in a window and on the phone page. */
	src: string;
	source: SessionArtworkSource;
}

export interface SessionTargetRepository {
	/** The main checkout's root (a worktree's sessions name the repository they came from). */
	root: string;
	/** The root folder's name: the letter mark's source and the row's repository name. */
	name: string;
	/** The GitHub owner its `origin` names, when it is a github.com repository. */
	owner?: string;
}

export interface SessionTarget {
	/**
	 * The folder the facts were read for: the session's folder, or, for a folder above several repositories, the
	 * repository its tool calls last worked in below it.
	 */
	path: string;
	/** Null: the folder is in no git repository. */
	repository: SessionTargetRepository | null;
	/** The checkout's HEAD; null outside a repository. */
	head: SessionTargetHead | null;
	/**
	 * The repository's image. Absent: not looked up yet, so ask `sessions.artwork` for `repository.root` and draw the
	 * letter mark meanwhile; null: it has none (the letter mark stays).
	 */
	artwork?: SessionArtwork | null;
}

/** One row to resolve: its session file and the folder that file records. */
export interface SessionTargetQuery {
	sessionPath: string;
	cwd: string;
}

/** Targets by session file. Null: the folder is gone or could not be read (draw the folder's letter mark). */
export type SessionTargets = Record<string, SessionTarget | null>;

/** Images by repository root. Null: the repository has none (or it could not be read in time). */
export type SessionArtworks = Record<string, SessionArtwork | null>;

/** Rows per `sessions.targets` call, roots per `sessions.artwork` call: ask again for the rest. */
export const SESSION_TARGET_BATCH = 24;
