/**
 * The project header's dialogs send one keyed change each for this computer's list: Move to group files the project
 * under a group (an existing one, a typed one, or none), Rename group renames every project's group, Appearance sets
 * the color and emoji.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpApi } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useSidebarPrefs } from "../../../stores/sidebar-prefs";
import ProjectDialog, { type ProjectDialogRequest } from "./ProjectDialogs";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const updateSidebar = vi.fn(async () => {});
const getHost = vi.fn<OmpApi["wslHost"]["get"]>();
const setHost = vi.fn<OmpApi["wslHost"]["set"]>();
const openExternal = vi.fn(async () => {});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		prefs: { updateSidebar, get: vi.fn(async () => null), onChanged: vi.fn(() => () => {}) },
		wslHost: { get: getHost, set: setHost },
		system: { openExternal },
	},
});

let root: Root | undefined;
const onClose = vi.fn();

/** The React props of a rendered element, to call its handlers as React would. */
function props(selector: string): Record<string, (event: unknown) => void> {
	const element = document.querySelector(selector) as unknown as Record<string, unknown> | null;
	if (!element) throw new Error(`missing ${selector}`);
	const key = Object.keys(element).find(name => name.startsWith("__reactProps$")) ?? "";
	return element[key] as Record<string, (event: unknown) => void>;
}

async function mount(request: ProjectDialogRequest): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ProjectDialog onClose={onClose} request={request} />
			</I18nProvider>,
		);
	});
}

async function run(selector: string, handler: string, event: unknown = {}): Promise<void> {
	await act(async () => props(selector)[handler]?.(event));
}

const submit = (form: string) => run(form, "onSubmit", { preventDefault: () => {} });

beforeEach(() => {
	useSidebarPrefs.setState({
		hydrated: true,
		projectGroups: { "/b": "Clients" },
		projectColors: {},
		projectEmoji: {},
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	updateSidebar.mockClear();
	onClose.mockClear();
	getHost.mockReset();
	setHost.mockReset();
	openExternal.mockClear();
	useSidebarPrefs.getState().reset();
});

describe("project execution host", () => {
	const cwd = "C:\\test\\project";
	const distro = { id: "{aba10101-abcd-1234-4321-123456789abc}", name: "Distro", version: 2, isDefault: true };
	async function click(name: string) {
		const button = [...document.querySelectorAll("button")].find(element => element.textContent === name);
		if (!button) throw new Error(`Missing button ${name}`);
		await act(async () => (button as unknown as HTMLButtonElement).click());
	}

	it("starts on Windows, shows only WSL 2 choices, and saves the registration only after confirmation", async () => {
		getHost.mockResolvedValue({ selected: null, distributions: [distro, { ...distro, id: "legacy", version: 1 }] });
		await mount({ kind: "host", cwd, name: "Project" });
		expect(getHost).toHaveBeenCalledWith(cwd);
		expect(document.querySelector('[data-choice=""]')?.getAttribute("aria-checked")).toBe("true");
		expect(document.querySelector('[data-choice="legacy"]')).toBeNull();
		await run(`[data-choice="${distro.id}"]`, "onClick");
		expect(document.body.textContent).toContain("WSL is not a sandbox");
		for (const label of ["WSL configuration", "File permissions", "WSL container API"]) await click(label);
		expect(openExternal.mock.calls).toEqual(
			["wsl-config", "file-permissions", "wsl-container"].map(page => [
				`https://learn.microsoft.com/en-us/windows/wsl/${page}`,
			]),
		);
		expect(setHost).not.toHaveBeenCalled();
		await click("Save");
		expect(setHost).toHaveBeenCalledWith(cwd, distro.id);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("does not silently replace a missing distro; Windows can be saved explicitly", async () => {
		getHost.mockResolvedValue({ selected: distro.id, distributions: [] });
		await mount({ kind: "host", cwd, name: "Project" });
		expect(document.body.textContent).toContain("no longer available");
		expect(document.querySelector('[aria-checked="true"]')).toBeNull();
		expect(setHost).not.toHaveBeenCalled();
		await run('[data-choice=""]', "onClick");
		setHost.mockRejectedValueOnce(new Error("raw core refusal"));
		await click("Save");
		expect(onClose).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t save this host");
		await click("Save");
		expect(setHost).toHaveBeenLastCalledWith(cwd, null);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("shows the localized reason when the window cannot read this project", async () => {
		getHost.mockRejectedValue(new Error("[wsl_host_local_only] refused"));
		await mount({ kind: "host", cwd, name: "Project" });
		expect(document.querySelector('[role="alert"]')?.textContent).toContain("local tab");
		expect(document.querySelector('[role="radio"]')).toBeNull();
	});
});

describe("Move to group", () => {
	it("files the project under a group already in use", async () => {
		await mount({ kind: "move", cwd: "/a", name: "alpha" });
		await run('[data-choice="Clients"]', "onClick");
		await submit("#project-group-move");
		expect(updateSidebar).toHaveBeenCalledWith({
			op: "set-entry",
			field: "projectGroups",
			key: "/a",
			value: "Clients",
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("files it under a group typed for it, over the one chosen", async () => {
		await mount({ kind: "move", cwd: "/a", name: "alpha" });
		await run('[data-choice="Clients"]', "onClick");
		await run("#project-group-move input", "onChange", { target: { value: " Tools " } });
		await submit("#project-group-move");
		expect(updateSidebar).toHaveBeenCalledWith({
			op: "set-entry",
			field: "projectGroups",
			key: "/a",
			value: "Tools",
		});
	});

	it("takes a project out of its group with No group", async () => {
		await mount({ kind: "move", cwd: "/b", name: "beta" });
		await run('[data-choice=""]', "onClick");
		await submit("#project-group-move");
		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-entry", field: "projectGroups", key: "/b", value: null });
	});
});

describe("Rename group", () => {
	it("renames the group for every project in it", async () => {
		await mount({ kind: "rename", group: "Clients" });
		await run("#project-group-rename input", "onChange", { target: { value: "Customers" } });
		await submit("#project-group-rename");
		expect(updateSidebar).toHaveBeenCalledWith({ op: "rename-project-group", from: "Clients", to: "Customers" });
	});
});

describe("Appearance", () => {
	it("sets the color and the emoji, and previews them first", async () => {
		await mount({ kind: "look", cwd: "/a", name: "alpha" });
		await run('[data-choice="teal"]', "onClick");
		await run("#project-look input", "onChange", { target: { value: "🚀" } });
		expect(document.querySelector("[data-project-look-preview] [data-project-emoji]")?.textContent).toBe("🚀");
		await submit("#project-look");
		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-entry", field: "projectColors", key: "/a", value: "teal" });
		expect(updateSidebar).toHaveBeenCalledWith({ op: "set-entry", field: "projectEmoji", key: "/a", value: "🚀" });
	});
});

describe("a session's parent and emoji", () => {
	it("nests the session under the one chosen, and Automatic gives it back to its opener", async () => {
		useSidebarPrefs.setState({ sessionParents: { "/s/c.jsonl": "/s/a.jsonl" } });
		const candidates = [
			{ path: "/s/a.jsonl", title: "Alpha" },
			{ path: "/s/b.jsonl", title: "Beta" },
		];
		await mount({ kind: "parent", path: "/s/c.jsonl", name: "Gamma", candidates });
		await run('[data-choice="/s/b.jsonl"]', "onClick");
		await submit("#session-parent");
		expect(updateSidebar).toHaveBeenLastCalledWith({
			op: "set-entry",
			field: "sessionParents",
			key: "/s/c.jsonl",
			value: "/s/b.jsonl",
		});
		await act(async () => root?.unmount());
		await mount({ kind: "parent", path: "/s/c.jsonl", name: "Gamma", candidates });
		await run('[data-choice="\u0000automatic"]', "onClick");
		await submit("#session-parent");
		expect(updateSidebar).toHaveBeenLastCalledWith({
			op: "set-entry",
			field: "sessionParents",
			key: "/s/c.jsonl",
			value: null,
		});
	});

	it("sets a session's emoji, and a `:name` still being typed sets none", async () => {
		await mount({ kind: "emoji", path: "/s/c.jsonl", name: "Gamma" });
		await run("#session-emoji input", "onChange", { target: { value: ":rock" } });
		await submit("#session-emoji");
		expect(updateSidebar).not.toHaveBeenCalled();
		await act(async () => root?.unmount());
		await mount({ kind: "emoji", path: "/s/c.jsonl", name: "Gamma" });
		await run("#session-emoji input", "onChange", { target: { value: "🐛" } });
		await submit("#session-emoji");
		expect(updateSidebar).toHaveBeenCalledWith({
			op: "set-entry",
			field: "sessionEmoji",
			key: "/s/c.jsonl",
			value: "🐛",
		});
	});
});
