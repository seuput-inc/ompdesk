import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectMetadataBatch } from "../../../../shared/project-metadata";
import { I18nProvider } from "../../../lib/i18n";
import { useProjectMetadata } from "../../../stores/project-metadata";
import { SidebarRepositoryImage } from "./SidebarRepositoryImage";

const { window, document, Event, HTMLElement, Element, Node } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
const get = vi.fn<(paths: string[], device?: string) => Promise<ProjectMetadataBatch>>();
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
let root: Root | undefined;
let container: HTMLDivElement;
async function show(paths: readonly string[], device?: string) {
	if (!root) {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	}
	Object.assign(window, { omp: { projectMetadata: { get } } });
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SidebarRepositoryImage paths={paths} device={device} />
			</I18nProvider>,
		);
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useProjectMetadata.getState().reset();
	get.mockReset();
});

it("keeps empty and multiple targets generic and never chooses one repository", async () => {
	await show([]);
	expect(container.querySelector("[data-repository-image=generic]")).not.toBeNull();
	await show(["/a", "/b"]);
	expect(container.querySelector("img")).toBeNull();
	expect(get).not.toHaveBeenCalled();
});

it("keeps the same 16px mark for host artwork and decoder failure", async () => {
	get.mockResolvedValue({
		"/a": {
			path: "/a",
			project: "a",
			repository: { root: "/a", head: { kind: "branch", name: "main" } },
			image: { dataUrl: PNG, source: "repository" },
		},
	});
	await show(["/a"], "synthetic-host");
	const mark = container.querySelector("[data-repository-image]");
	const image = container.querySelector("img");
	expect(image?.getAttribute("width")).toBe("16");
	expect(image?.getAttribute("height")).toBe("16");
	expect(get).toHaveBeenCalledWith(["/a"], "synthetic-host");
	await act(async () => {
		image?.dispatchEvent(new Event("error"));
	});
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("[data-repository-image]")).toBe(mark);
	expect(mark?.getAttribute("data-repository-image")).toBe("generic");
});

it("does not repaint the previous target when its request answers late", async () => {
	const old = Promise.withResolvers<ProjectMetadataBatch>();
	get.mockReturnValueOnce(old.promise);
	get.mockResolvedValueOnce({ "/b": { path: "/b", project: "b", repository: null, image: null } });
	await show(["/a"]);
	await show(["/b"]);
	await act(async () => {
		old.resolve({
			"/a": {
				path: "/a",
				project: "a",
				repository: { root: "/a", head: { kind: "branch", name: "main" } },
				image: { dataUrl: PNG, source: "owner" },
			},
		});
	});
	expect(container.querySelector("img")).toBeNull();
	expect(container.querySelector("[data-repository-image=generic]")).not.toBeNull();
});
