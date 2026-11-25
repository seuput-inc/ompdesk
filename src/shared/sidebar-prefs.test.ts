import { describe, expect, it } from "vitest";
import { isMutedFolder, mutedGroupsOf } from "./sidebar-prefs";

describe("isMutedFolder", () => {
	it("mutes the project itself and any folder under it", () => {
		expect(isMutedFolder(["/a/b"], {}, "/a/b")).toBe(true);
		expect(isMutedFolder(["/a/b"], {}, "/a/b/src")).toBe(true);
		expect(isMutedFolder(["/a/b/"], {}, "/a/b/src")).toBe(true);
		expect(isMutedFolder([], {}, "/a/b")).toBe(false);
	});

	it("does not mute a sibling that only shares the prefix", () => {
		expect(isMutedFolder(["/a/b"], {}, "/a/bc")).toBe(false);
		expect(isMutedFolder(["/a/b"], {}, "/a")).toBe(false);
	});

	it("mutes a linked worktree of a muted project", () => {
		expect(isMutedFolder(["/a/b"], { "/wt/b-x": "/a/b" }, "/wt/b-x")).toBe(true);
		expect(isMutedFolder(["/a/b"], { "/wt/c-x": "/a/c" }, "/wt/c-x")).toBe(false);
	});

	it("reads Windows separators", () => {
		expect(isMutedFolder(["C:\\work\\app"], {}, "C:\\work\\app\\src")).toBe(true);
		expect(isMutedFolder(["C:\\work\\app"], {}, "C:\\work\\apple")).toBe(false);
	});
});

describe("mutedGroupsOf", () => {
	it("reads the muted list of a raw blob and nothing from a malformed one", () => {
		expect(mutedGroupsOf({ mutedGroups: ["/a", 3, ""], pinnedGroups: ["/p"] })).toEqual(["/a"]);
		expect(mutedGroupsOf(null)).toEqual([]);
		expect(mutedGroupsOf({ mutedGroups: "/a" })).toEqual([]);
	});
});
