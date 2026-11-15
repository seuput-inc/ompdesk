import type { RepoImage } from "./repo-images";

export type RepositoryHead =
	| { kind: "branch"; name: string }
	| { kind: "detached"; sha: string }
	| { kind: "unborn"; name: string };

/** One execution-host snapshot. The checkout path and its branch never borrow another worktree's identity. */
export interface ProjectMetadata {
	path: string;
	project: string;
	repository: { root: string; head: RepositoryHead } | null;
	image: RepoImage | null;
}

export type ProjectMetadataBatch = Record<string, ProjectMetadata | null>;

/** Small enough for the page/link frame even when every icon is a fresh 64px raster. */
export const PROJECT_METADATA_BATCH = 24;
