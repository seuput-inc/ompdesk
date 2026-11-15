import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectMetadata, ProjectMetadataBatch } from "../../shared/project-metadata";
import { projectMetadataKey, useProjectMetadata } from "./project-metadata";

const get = vi.fn<(paths: string[], device?: string) => Promise<ProjectMetadataBatch>>();
const metadata = (path: string, branch = "main"): ProjectMetadata => ({
	path,
	project: "synthetic",
	repository: { root: path, head: { kind: "branch", name: branch } },
	image: null,
});
const tick = async () => {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
};
beforeEach(() => {
	Object.assign(globalThis, { window: { omp: { projectMetadata: { get } } } });
});
afterEach(() => {
	useProjectMetadata.getState().reset();
	get.mockReset();
});

it("coalesces row lookups per execution host and does not retry an offline host", async () => {
	get.mockResolvedValueOnce({ "/a": metadata("/a"), "/b": metadata("/b") });
	get.mockRejectedValueOnce(new Error("offline"));
	useProjectMetadata.getState().request(["/a"]);
	useProjectMetadata.getState().request(["/a", "/b"]);
	useProjectMetadata.getState().request(["/a"], "other-host");
	await tick();
	expect(get.mock.calls).toEqual([
		[["/a", "/b"], undefined],
		[["/a"], "other-host"],
	]);
	expect(useProjectMetadata.getState().entries[projectMetadataKey("/a")]).toEqual(metadata("/a"));
	expect(useProjectMetadata.getState().entries[projectMetadataKey("/a", "other-host")]).toBeNull();
	useProjectMetadata.getState().request(["/a"], "other-host");
	await tick();
	expect(get).toHaveBeenCalledTimes(2);
});

it("ignores an older response after an explicit refresh and preserves one complete image/head snapshot", async () => {
	const older = Promise.withResolvers<ProjectMetadataBatch>();
	get.mockReturnValueOnce(older.promise);
	get.mockResolvedValueOnce({ "/a": metadata("/a", "new") });
	useProjectMetadata.getState().request(["/a"]);
	await tick();
	useProjectMetadata.getState().refresh(["/a"]);
	await tick();
	older.resolve({ "/a": metadata("/a", "old") });
	await tick();
	expect(useProjectMetadata.getState().entries[projectMetadataKey("/a")]).toEqual(metadata("/a", "new"));
});

it("keeps a known snapshot offline without borrowing another host's image", async () => {
	get.mockResolvedValueOnce({ "/a": metadata("/a") });
	useProjectMetadata.getState().request(["/a"]);
	await tick();
	get.mockRejectedValueOnce(new Error("offline"));
	useProjectMetadata.getState().refresh(["/a"]);
	await tick();
	expect(useProjectMetadata.getState().entries[projectMetadataKey("/a")]).toEqual(metadata("/a"));
	expect(useProjectMetadata.getState().entries[projectMetadataKey("/a", "other-host")]).toBeUndefined();
});
