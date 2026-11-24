/**
 * `Menu` over the host protocol (PROTOCOL.md §7): a popup menu (a text field's context menu, a window's) is built here
 * from Electron's template, its click handlers stay in Node, and the shell gets a plain description (`id`, `label`,
 * `accelerator`, …) and answers `menu.popup` with the chosen item's id. The edit roles run here; on macOS one without a
 * click handler goes to AppKit's first responder. The application menu and the tray are the shell's own
 * (`tauri-shell/src/app_menu.rs`, `tray.rs`).
 */
import type { Host } from "./host";

interface Window {
	id: number;
	webContents: WindowContents;
}

type PopupOptions = { window?: { id: number }; x?: number; y?: number; callback?: () => void };
type PopupFn = (menu: Menu, options: PopupOptions) => void;
interface WindowContents {
	undo(): void;
	redo(): void;
	cut(): void;
	copy(): void;
	paste(): void;
	selectAll(): void;
}

export interface MenuItemOptions {
	id?: string;
	label?: string;
	type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
	enabled?: boolean;
	visible?: boolean;
	checked?: boolean;
	accelerator?: string;
	sublabel?: string;
	toolTip?: string;
	role?: string;
	submenu?: MenuItemOptions[] | Menu;
	click?: (item: MenuItem, window: Window | undefined, event: unknown) => void;
	registerAccelerator?: boolean;
}

export interface MenuDeps {
	focusedWindow(): Window | null;
}

const MAC = process.platform === "darwin";

/** Roles handled here: label, Electron's default accelerator and the action. */
const ROLES: Record<string, { label: string; accelerator?: string; run(window: Window | null): void }> = {
	undo: { label: "Undo", accelerator: "CommandOrControl+Z", run: w => w?.webContents.undo() },
	redo: {
		label: "Redo",
		accelerator: MAC ? "Shift+CommandOrControl+Z" : "Control+Y",
		run: w => w?.webContents.redo(),
	},
	cut: { label: "Cut", accelerator: "CommandOrControl+X", run: w => w?.webContents.cut() },
	copy: { label: "Copy", accelerator: "CommandOrControl+C", run: w => w?.webContents.copy() },
	paste: { label: "Paste", accelerator: "CommandOrControl+V", run: w => w?.webContents.paste() },
	selectAll: { label: "Select All", accelerator: "CommandOrControl+A", run: w => w?.webContents.selectAll() },
};

let nextItem = 0;

export class MenuItem {
	readonly id: string;
	readonly commandId: string;
	label: string;
	type: NonNullable<MenuItemOptions["type"]>;
	enabled: boolean;
	visible: boolean;
	checked: boolean;
	accelerator: string | undefined;
	sublabel: string | undefined;
	toolTip: string | undefined;
	role: string | undefined;
	submenu: Menu | undefined;
	readonly click: (event?: unknown, window?: Window, webContents?: unknown) => void;
	readonly #nativeEdit: boolean;
	readonly #deps: MenuDeps;

	constructor(options: MenuItemOptions, deps: MenuDeps, toMenu: (items: MenuItemOptions[]) => Menu) {
		this.#deps = deps;
		this.commandId = `i${++nextItem}`;
		this.id = options.id ?? "";
		const role = options.role;
		const known = role === undefined ? undefined : ROLES[role];
		this.role = role;
		this.#nativeEdit = MAC && !options.click && known !== undefined;
		this.label = options.label ?? known?.label ?? "";
		this.type = options.type ?? (options.submenu ? "submenu" : "normal");
		this.enabled = options.enabled !== false;
		this.visible = options.visible !== false;
		this.checked = options.checked === true;
		this.accelerator = options.accelerator ?? known?.accelerator;
		this.sublabel = options.sublabel;
		this.toolTip = options.toolTip;
		this.submenu = Array.isArray(options.submenu) ? toMenu(options.submenu) : options.submenu;
		this.click = (event, window) => {
			if (this.type === "checkbox") this.checked = !this.checked;
			const target = window ?? deps.focusedWindow() ?? undefined;
			if (known && !options.click) known.run(target ?? null);
			options.click?.(this, target, event);
		};
	}

	/** Runs the item as the shell reported its choice. */
	activate(): void {
		this.click(undefined, this.#deps.focusedWindow() ?? undefined);
	}

	toWire(): Record<string, unknown> {
		return {
			id: this.commandId,
			label: this.label,
			type: this.type,
			enabled: this.enabled,
			visible: this.visible,
			checked: this.checked,
			...(this.accelerator === undefined ? {} : { accelerator: this.accelerator }),
			...(this.sublabel === undefined ? {} : { sublabel: this.sublabel }),
			...(this.toolTip === undefined ? {} : { toolTip: this.toolTip }),
			...(this.#nativeEdit && this.role !== undefined ? { role: this.role } : {}),
			...(this.submenu ? { submenu: this.submenu.toWire() } : {}),
		};
	}

	find(commandId: string): MenuItem | undefined {
		if (this.commandId === commandId) return this;
		return this.submenu?.findCommand(commandId);
	}
}

export class Menu {
	readonly items: MenuItem[] = [];
	readonly #deps: MenuDeps;
	readonly #popup: PopupFn;
	menuId = 0;

	constructor(deps: MenuDeps, popup: PopupFn) {
		this.#deps = deps;
		this.#popup = popup;
	}

	append(item: MenuItem): void {
		this.items.push(item);
	}

	insert(position: number, item: MenuItem): void {
		this.items.splice(position, 0, item);
	}

	getMenuItemById(id: string): MenuItem | null {
		const walk = (items: MenuItem[]): MenuItem | null => {
			for (const item of items) {
				if (item.id === id) return item;
				const inner = item.submenu ? walk(item.submenu.items) : null;
				if (inner) return inner;
			}
			return null;
		};
		return walk(this.items);
	}

	/** Adds the items of a template (Menu.buildFromTemplate's work). */
	fill(template: MenuItemOptions[], toMenu: (items: MenuItemOptions[]) => Menu): void {
		for (const options of template) this.append(new MenuItem(options, this.#deps, toMenu));
	}

	popup(options: PopupOptions = {}): void {
		this.#popup(this, options);
	}

	closePopup(): void {}

	toWire(): Array<Record<string, unknown>> {
		return this.items.map(item => item.toWire());
	}

	findCommand(commandId: string): MenuItem | undefined {
		for (const item of this.items) {
			const found = item.find(commandId);
			if (found) return found;
		}
		return undefined;
	}
}

export function createMenuModule(host: Host, deps: MenuDeps) {
	const popup: PopupFn = (menu, options) => {
		const winId = options.window?.id ?? deps.focusedWindow()?.id;
		host.client
			.call<{ itemId: string | null }>("menu.popup", {
				menuId: menu.menuId,
				template: menu.toWire(),
				winId,
				x: options.x,
				y: options.y,
			})
			.then(
				({ itemId }) => {
					if (itemId) menu.findCommand(itemId)?.activate();
					options.callback?.();
				},
				(error: unknown) => host.warn(`menu.popup: ${String(error)}`),
			);
	};

	const build = (template: MenuItemOptions[]): Menu => {
		const menu = new Menu(deps, popup);
		menu.menuId = host.nextMenuId();
		menu.fill(template, build);
		return menu;
	};

	return { Menu: Object.assign(Menu, { buildFromTemplate: build }) };
}
