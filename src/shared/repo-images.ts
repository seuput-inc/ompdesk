/** Bytes, never a fetch URL: all artwork resolves and is rasterized on the repository's execution host. */
export interface RepoImage {
	dataUrl: string;
	source: "repository" | "homepage" | "owner";
}
