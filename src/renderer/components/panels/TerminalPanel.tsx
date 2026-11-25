import type { ITheme, Terminal } from "@xterm/xterm";
import {
	Bookmark,
	ChevronDown,
	ClipboardPaste,
	Columns2,
	Copy,
	Eraser,
	Keyboard,
	Maximize2,
	Minimize2,
	Pencil,
	Plus,
	RotateCcw,
	RotateCw,
	Rows2,
	Search,
	Square,
	SquareTerminal,
	Terminal as TerminalIcon,
	TextSelect,
	Trash2,
	X,
} from "lucide-react";
import {
	type DragEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { shellKindOf, shellQuote } from "../../../shared/shell-quote";
import type { SshTarget } from "../../../shared/ssh-tools";
import { commandInput, commandsFor } from "../../../shared/terminal-commands";
import {
	TERMINAL_OUTPUT_BUDGET,
	TERMINAL_SHELL_PREF,
	type TerminalLeaseState,
	type TerminalOperation,
	type TerminalShell,
	type TerminalSnapshot,
} from "../../../shared/terminal-types";
import { currentShellMode, useCompactShell, useShellInput } from "../../hooks/use-shell-mode";
import { FILE_DRAG_TYPE, readFileDrag } from "../../lib/file-drag";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	actionKbd,
	chordFromEvent,
	compileKeymap,
	KEYMAP_ACTIONS,
	type KeymapOverrides,
	PLATFORM,
} from "../../lib/keymap";
import { openLocalPath, verifyPath } from "../../lib/markdown-path-link";
import { openExternal } from "../../lib/open-external";
import { markTabOnBell } from "../../lib/terminal-bell";
import {
	applyModifiers,
	clampFontScale,
	FONT_SCALE_DEFAULT,
	FONT_SCALE_STEP,
	fontSizeFor,
	type HeldModifiers,
	isSingleKey,
	optionWordMotion,
	type TerminalKey,
	zoomKey,
} from "../../lib/terminal-keys";
import { isLinkClick, pathLinkProvider } from "../../lib/terminal-links";
import { TerminalLocalEcho } from "../../lib/terminal-local-echo";
import { osc52Handler } from "../../lib/terminal-osc52";
import {
	closeTerminal,
	focusedTerminal,
	NO_PANES,
	pickTerminal,
	type SplitDirection,
	splitTerminal,
	type TerminalPanes,
	unsplit,
} from "../../lib/terminal-panes";
import { pollTerminal } from "../../lib/terminal-poll";
import { chromePlatform } from "../../lib/window-chrome";
import { useTabsStore } from "../../stores/tabs";
import { ensureTerminalCommands, useTerminalCommandsStore } from "../../stores/terminal-commands";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	anchorFromEvent,
	Banner,
	Button,
	ConfirmDialog,
	ContextMenu,
	type ContextMenuAnchor,
	type ContextMenuItem,
	EmptyState,
	ErrorDetail,
	IconButton,
	Input,
	MenuButton,
	Modal,
	Spinner,
	Tabs,
} from "../common";
import { TerminalCommandsDialog } from "./TerminalCommandsDialog";
import { TerminalFind, type TerminalSearch } from "./TerminalFind";
import { AddToChatButton } from "./notes/AddToChat";
import { TerminalKeyBar } from "./TerminalKeyBar";
import "@xterm/xterm/css/xterm.css";

const FONT_SCALE_KEY = "omp.terminalFontScale";
const MAC = PLATFORM === "mac";
/** How long a close waits to learn whether a command runs before it asks anyway (Orca's 4 s probe deadline). */
const BUSY_PROBE_MS = 4000;

function readFontScale(): number {
	try {
		const stored = Number(window.localStorage.getItem(FONT_SCALE_KEY));
		return stored > 0 ? clampFontScale(stored) : FONT_SCALE_DEFAULT;
	} catch {
		return FONT_SCALE_DEFAULT;
	}
}

/** xterm's palette for the page's theme: the surface, the text, the selection and the theme's own ANSI 16 (`--omp-ansi-*`). */
export function terminalTheme(element: HTMLElement): ITheme {
	const style = getComputedStyle(element);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const color = (name: string) => read(`--sc-${name}`);
	const ansi = (name: string) => read(`--omp-ansi-${name}`);
	return {
		background: color("surface-1"),
		foreground: color("text"),
		cursor: color("text"),
		cursorAccent: color("surface-1"),
		selectionBackground: read("--omp-selection-bg"),
		black: ansi("black"),
		red: ansi("red"),
		green: ansi("green"),
		yellow: ansi("yellow"),
		blue: ansi("blue"),
		magenta: ansi("magenta"),
		cyan: ansi("cyan"),
		white: ansi("white"),
		brightBlack: ansi("bright-black"),
		brightRed: ansi("bright-red"),
		brightGreen: ansi("bright-green"),
		brightYellow: ansi("bright-yellow"),
		brightBlue: ansi("bright-blue"),
		brightMagenta: ansi("bright-magenta"),
		brightCyan: ansi("bright-cyan"),
		brightWhite: ansi("bright-white"),
	};
}

export interface TerminalMount {
	terminal: Pick<
		Terminal,
		| "cols"
		| "rows"
		| "options"
		| "write"
		| "onData"
		| "focus"
		| "clear"
		| "getSelection"
		| "dispose"
		| "attachCustomKeyEventHandler"
	> &
		/** xterm always has them; a test double without one never paints predictions, draws another viewer's size or rings. */
		Partial<
			Pick<
				Terminal,
				| "buffer"
				| "resize"
				| "reset"
				| "onBell"
				| "onTitleChange"
				| "selectAll"
				| "clearSelection"
				| "parser"
				| "registerLinkProvider"
			>
		>;
	fit(): void;
	/** Find in the scrollback (`@xterm/addon-search`). */
	search?: TerminalSearch;
	/** A web link's click (`@xterm/addon-web-links`), routed by the viewport that holds the screen. */
	onUrl?: (event: MouseEvent, uri: string) => void;
}
export async function mountTerminal(element: HTMLElement): Promise<TerminalMount> {
	// Browser-only UMD modules require `self`; keep them out of Node/linkedom import paths.
	const [{ Terminal }, { FitAddon }, { SearchAddon }, { WebLinksAddon }] = await Promise.all([
		import("@xterm/xterm"),
		import("@xterm/addon-fit"),
		import("@xterm/addon-search"),
		import("@xterm/addon-web-links"),
	]);
	const terminal = new Terminal({
		cursorBlink: true,
		fontSize: 12,
		// The app's own monospace face (Orca FT20: one right answer, so no font setting).
		fontFamily: getComputedStyle(element).getPropertyValue("--sc-font-mono").trim() || "monospace",
		scrollback: 10000,
		theme: terminalTheme(element),
		// Search highlights are decorations, a proposed API in xterm 6.
		allowProposedApi: true,
		// Option composes text (accents, other layouts); Option+B/F/D still move by word (`optionWordMotion`).
		macOptionIsMeta: false,
	});
	const fit = new FitAddon();
	const search = new SearchAddon();
	terminal.loadAddon(fit);
	terminal.loadAddon(search);
	const mount: TerminalMount = { terminal, fit: () => fit.fit(), search };
	terminal.loadAddon(new WebLinksAddon((event, uri) => mount.onUrl?.(event, uri)));
	terminal.open(element);
	return mount;
}

/** The screen cleared here as the PTY's kept output was: the scrollback and the visible rows. */
function clearScreen(view: TerminalMount): void {
	view.terminal.clear();
	view.terminal.write("\u001b[2J\u001b[3J\u001b[H");
}

/** The keymap's terminal actions a focused terminal takes before its shell sees the key. */
let compiledKeymap: { overrides: KeymapOverrides; map: Map<string, string> } | null = null;
function terminalAction(event: KeyboardEvent): "terminal.find" | "terminal.new" | "terminal.quick" | null {
	const chord = chordFromEvent(event);
	if (!chord) return null;
	const overrides = useUiStore.getState().keymapOverrides;
	if (compiledKeymap?.overrides !== overrides)
		compiledKeymap = { overrides, map: compileKeymap(KEYMAP_ACTIONS, overrides) };
	const action = compiledKeymap.map.get(chord);
	return action === "terminal.find" || action === "terminal.new" || action === "terminal.quick" ? action : null;
}

/** One notice per page when a program's OSC 52 copy could not reach the clipboard. */
let osc52Warned = false;

/** The items a terminal's menu adds for its panel (rename, split) and the close, which goes last. */
export interface TerminalMenuExtra {
	panes: ContextMenuItem[];
	close?: ContextMenuItem;
}

export function TerminalViewport({
	tabId,
	id,
	onStatus,
	onError,
	mount = mountTerminal,
	handle,
	predict = false,
	transform,
	fontSize,
	onLease,
	claimTick = 0,
	takeFocus = true,
	shell,
	onTitle,
	onZoom,
	onFocusPane,
	menu,
	exited = false,
}: {
	tabId: string;
	id: string;
	onStatus: (snapshot: TerminalSnapshot) => void;
	onError: (error: string) => void;
	mount?: (element: HTMLElement) => TerminalMount | Promise<TerminalMount>;
	handle: { current: TerminalMount | null };
	/** Paint typed characters before the host echoes them (a paired host's tab, C109). */
	predict?: boolean;
	/** What typed data becomes before it is written (the key bar's sticky Ctrl and Alt). */
	transform?: (data: string) => string;
	/** The terminal's font size in px; changing it refits the screen. */
	fontSize?: number;
	/** Focus the shell once it is up; false when the arrow keys switched sessions and focus stays on the tabs. */
	takeFocus?: boolean;
	/** Who sizes the PTY changed (`other`: another viewer does, this one draws the PTY at its size). */
	onLease?: (lease: TerminalLeaseState | undefined) => void;
	/** Bumped after this viewer took the PTY's size (`claim`): it fits and resizes again. */
	claimTick?: number;
	/** The shell's program name: how a dropped path is quoted. */
	shell?: string;
	/** The program set the terminal's title (OSC 0/2). */
	onTitle?: (title: string) => void;
	/** ⌘= ⌘− ⌘0 in the terminal. */
	onZoom?: (change: "smaller" | "larger" | "reset") => void;
	/** The keyboard or a pointer went into this screen (a split panel's pane takes the focus). */
	onFocusPane?: () => void;
	menu?: TerminalMenuExtra;
	exited?: boolean;
}) {
	const element = useRef<HTMLDivElement>(null);
	const t = useT();
	// The running effect's own pieces, for the effects below that react to a prop without restarting it.
	const refit = useRef<(() => void) | null>(null);
	/** This viewer sizes the PTY (the screen fits its box); otherwise it draws another viewer's size and scrolls. */
	const [sized, setSized] = useState(true);
	const fontChanged = useRef<(() => void) | null>(null);
	const latest = useRef({ transform, fontSize, onLease, takeFocus, onTitle, onZoom, shell, t });
	latest.current = { transform, fontSize, onLease, takeFocus, onTitle, onZoom, shell, t };
	/** Bumped when xterm's parser stuck: the effect builds a new screen, which reads the kept scrollback again (U172). */
	const [screen, setScreen] = useState(0);
	const [search, setSearch] = useState<TerminalSearch | null>(null);
	const [finding, setFinding] = useState(false);
	const [menuAt, setMenuAt] = useState<(ContextMenuAnchor & { selection: boolean }) | null>(null);
	const write = useCallback(
		(data: string) =>
			window.omp.terminal.request(tabId, { action: "write", id, data }).catch(error => onError(String(error))),
		[tabId, id, onError],
	);
	const copy = useCallback(async () => {
		const view = handle.current;
		const text = view?.terminal.getSelection() ?? "";
		if (!text) return;
		await navigator.clipboard.writeText(text).catch(error => onError(String(error)));
	}, [handle, onError]);
	const paste = useCallback(async () => {
		const text = await navigator.clipboard.readText().catch(error => {
			onError(String(error));
			return "";
		});
		if (text) await write(text);
	}, [write, onError]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: screen explicitly replaces a stuck xterm.
	useEffect(() => {
		if (!element.current) return;
		const target = element.current;
		let stopped = false;
		let cleanup = () => {};
		void (async () => {
			const view = await mount(target);
			if (stopped) {
				view.terminal.dispose();
				return;
			}
			handle.current = view;
			setSearch(view.search ?? null);
			const request = async (operation: TerminalOperation) => {
				try {
					return await window.omp.terminal.request(tabId, operation);
				} catch (error) {
					if (!stopped) onError(error instanceof Error ? error.message : String(error));
					return null;
				}
			};
			const echo = predict
				? new TerminalLocalEcho({
						write: data => view.terminal.write(data),
						anchor: () => {
							const buffer = view.terminal.buffer?.active;
							if (buffer?.type !== "normal") return null;
							const line = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
							return line.length <= buffer.cursorX ? buffer.cursorX : null;
						},
						cols: () => view.terminal.cols,
					})
				: null;
			const input = view.terminal.onData(data => {
				echo?.input(data);
				void request({ action: "write", id, data: latest.current.transform?.(data) ?? data });
			});
			const bell = view.terminal.onBell?.(() => markTabOnBell(tabId));
			const title = view.terminal.onTitleChange?.(value => latest.current.onTitle?.(value));
			// Output read back from the kept scrollback (this screen catching up, or starting over after a cut) is
			// history: a program's clipboard copy in it is old and must not overwrite a newer one.
			let replaying = true;
			const osc52 = view.terminal.parser?.registerOscHandler(
				52,
				osc52Handler({
					replaying: () => replaying,
					write: text => navigator.clipboard.writeText(text),
					onFailure: () => {
						if (osc52Warned) return;
						osc52Warned = true;
						toast({ variant: "warning", message: latest.current.t("panel.terminal.osc52Failed") });
					},
				}),
			);
			// ⌘-click (Ctrl-click on Windows) opens a link; Shift takes the other way for a web link (Orca FT10).
			view.onUrl = (event, uri) => {
				if (!isLinkClick(event, MAC)) return;
				const ui = useUiStore.getState();
				if (ui.linkPreview !== event.shiftKey && /^https?:\/\//i.test(uri)) ui.openPreview(uri);
				else openExternal(uri);
			};
			const links = view.terminal.registerLinkProvider?.(
				pathLinkProvider({
					buffer: () => view.terminal.buffer?.active,
					cols: () => view.terminal.cols,
					exists: async path => (await verifyPath(path, tabId)) !== "missing",
					open: (event, path, line) => {
						if (isLinkClick(event, MAC)) void openLocalPath(path, tabId, line);
					},
				}),
			);
			view.terminal.attachCustomKeyEventHandler(event => {
				if (event.type !== "keydown") return true;
				const action = terminalAction(event);
				if (action === "terminal.find") {
					event.preventDefault();
					setFinding(true);
					return false;
				}
				// The keymap (App) starts the terminal; the shell never sees the chord.
				if (action === "terminal.new" || action === "terminal.quick") return false;
				const zoom = zoomKey(event, MAC);
				if (zoom && latest.current.onZoom) {
					event.preventDefault();
					latest.current.onZoom(zoom);
					return false;
				}
				const motion = MAC ? optionWordMotion(event) : null;
				if (motion) {
					event.preventDefault();
					void request({ action: "write", id, data: motion });
					return false;
				}
				const copyKey =
					(event.metaKey && event.key === "c") ||
					(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c");
				const pasteKey =
					(event.metaKey && event.key === "v") ||
					(event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v");
				if (copyKey) {
					void navigator.clipboard.writeText(view.terminal.getSelection()).catch(error => onError(String(error)));
					return false;
				}
				if (pasteKey) {
					void navigator.clipboard
						.readText()
						.then(data => request({ action: "write", id, data }))
						.catch(error => onError(String(error)));
					return false;
				}
				return true;
			});
			// Who sizes the PTY (lease.ts): while another viewer does, this one draws the PTY at that size and
			// neither fits to its own box nor asks for a resize.
			let lease: TerminalLeaseState | undefined;
			const resize = () => {
				if (lease === "other") return;
				if (!element.current || element.current.clientWidth === 0 || element.current.clientHeight === 0) return;
				view.fit();
				void request({ action: "resize", id, cols: view.terminal.cols, rows: view.terminal.rows });
			};
			const onSnapshot = (snapshot: TerminalSnapshot) => {
				// An answer with nothing new: this screen has caught up with the PTY.
				if (!snapshot.output) replaying = false;
				if (snapshot.lease !== lease) {
					lease = snapshot.lease;
					setSized(lease !== "other");
					latest.current.onLease?.(lease);
					if (lease !== "other") resize();
				}
				if (
					lease === "other" &&
					snapshot.cols &&
					snapshot.rows &&
					(snapshot.cols !== view.terminal.cols || snapshot.rows !== view.terminal.rows)
				)
					view.terminal.resize?.(snapshot.cols, snapshot.rows);
				onStatus(snapshot);
			};
			const applyFontSize = () => {
				const size = latest.current.fontSize;
				if (size === undefined || view.terminal.options.fontSize === size) return;
				view.terminal.options.fontSize = size;
				resize();
			};
			refit.current = () => {
				// A claim answers `you` on the next snapshot; fit now so the screen does not wait for it.
				lease = "you";
				setSized(true);
				applyFontSize();
				resize();
			};
			// Fitting resizes xterm's own DOM inside the observed box (and a scrollbar may appear): done in the
			// observer's callback WebKit reports that as a ResizeObserver loop error, so it runs a tick later.
			let fitTimer: ReturnType<typeof setTimeout> | undefined;
			const observer = new ResizeObserver(() => {
				clearTimeout(fitTimer);
				fitTimer = setTimeout(resize, 0);
			});
			observer.observe(target);
			const theme = new MutationObserver(() => {
				if (element.current) view.terminal.options.theme = terminalTheme(element.current);
			});
			theme.observe(document.documentElement, { attributes: true });
			applyFontSize();
			resize();
			if (latest.current.takeFocus) view.terminal.focus();
			// A new font size arrives through `latest`; the effect below calls this.
			fontChanged.current = applyFontSize;
			// One read loop for every window: the host holds each request until the PTY writes or changes (at most
			// 1 s), and the next request is the acknowledgement of the last output (terminal-poll.ts), so an idle shell
			// costs one request a second instead of twelve. A phone's link drops and comes back, so it asks again; a
			// desktop window's failed request is the panel's error and its read stops, as before.
			const web = chromePlatform() === "web";
			let failed = false;
			void pollTerminal({
				id,
				request: async operation => {
					const snapshots = await request(operation);
					if (!snapshots && !web) failed = true;
					return snapshots;
				},
				write: output => {
					const { promise, resolve } = Promise.withResolvers<void>();
					view.terminal.write(echo ? echo.output(output) : output, () => {
						// An answer the budget did not cut reached the PTY's end: what follows is live.
						if (output.length < TERMINAL_OUTPUT_BUDGET) replaying = false;
						resolve();
					});
					return promise;
				},
				onSnapshot,
				// The answer starts past the kept scrollback's head: what is on screen has a hole after it (H139).
				reset: () => {
					replaying = true;
					view.terminal.reset?.();
				},
				// A full-screen program whose first frame was cut leaves the screen blank: only then it is asked to draw
				// again (H137); a screen with anything on it is left alone.
				settled: () => {
					const buffer = view.terminal.buffer?.active;
					if (!buffer) return;
					for (let row = 0; row < view.terminal.rows; row += 1)
						if (
							buffer
								.getLine(buffer.viewportY + row)
								?.translateToString(true)
								.trim()
						)
							return;
					void window.omp.terminal.request(tabId, { action: "redraw", id }).catch(() => {});
				},
				// xterm parses in order: an empty write behind a late one tells a lost callback from a stuck parser.
				probe: () => {
					const { promise, resolve } = Promise.withResolvers<void>();
					view.terminal.write("", resolve);
					return promise;
				},
				hidden: () => document.visibilityState === "hidden",
				// The PTY keeps running: only this screen is replaced, and the new one replays what the host kept.
				wedged: () => {
					if (!stopped) setScreen(count => count + 1);
				},
				stopped: () => stopped || failed,
			});
			cleanup = () => {
				refit.current = null;
				fontChanged.current = null;
				clearTimeout(fitTimer);
				observer.disconnect();
				theme.disconnect();
				input.dispose();
				bell?.dispose();
				title?.dispose();
				osc52?.dispose();
				links?.dispose();
				echo?.dispose();
				view.onUrl = undefined;
				view.terminal.dispose();
				if (handle.current === view) handle.current = null;
				setSearch(null);
			};
		})().catch(error => {
			if (!stopped) onError(String(error));
		});
		return () => {
			stopped = true;
			cleanup();
		};
	}, [tabId, id, mount, onStatus, onError, handle, predict, screen]);
	useEffect(() => {
		if (fontSize !== undefined) fontChanged.current?.();
	}, [fontSize]);
	useEffect(() => {
		if (claimTick > 0) refit.current?.();
	}, [claimTick]);
	const windows = PLATFORM === "windows";
	/**
	 * Windows' terminals paste on a right click (copy when text is selected; Orca FT14), with Ctrl held it opens the
	 * menu. The press is taken before xterm reports it, so a mouse-aware program never pastes a second time.
	 */
	const onMouseDownCapture = (event: ReactMouseEvent) => {
		if (!windows || event.button !== 2 || event.ctrlKey) return;
		event.preventDefault();
		event.stopPropagation();
		handle.current?.terminal.focus();
	};
	const onContextMenu = (event: ReactMouseEvent) => {
		const view = handle.current;
		if (!view) return;
		const selection = Boolean(view.terminal.getSelection());
		if (windows && !event.ctrlKey) {
			event.preventDefault();
			if (selection) void copy().then(() => view.terminal.clearSelection?.());
			else if (!exited) void paste();
			return;
		}
		setMenuAt({ ...anchorFromEvent(event), selection });
	};
	/** A file dropped from the computer or the Files panel types its quoted path, as a terminal does (Orca FT11). */
	const onDrop = async (event: DragEvent) => {
		const fromFiles = readFileDrag(event.dataTransfer);
		const files = [...event.dataTransfer.files];
		if (!fromFiles && files.length === 0) return;
		event.preventDefault();
		// shortcut: a paired host's tab takes only Files-panel paths; this computer's files need an upload first.
		const paths = fromFiles
			? [fromFiles.path]
			: predict
				? []
				: await Promise.all(files.map(file => Promise.resolve(window.omp.fs.pathForFile(file)).catch(() => "")));
		const kind = shellKindOf(latest.current.shell, windows);
		const typed = paths
			.filter(Boolean)
			.map(path => shellQuote(path, kind))
			.join(" ");
		if (typed) await write(`${typed} `);
		handle.current?.terminal.focus();
	};
	const items: ContextMenuItem[] = menuAt
		? [
				{
					id: "copy",
					label: t("panel.terminal.copy"),
					icon: Copy,
					disabled: !menuAt.selection,
					shortcut: MAC ? "⌘C" : "⇧⌃C",
					onSelect: () => void copy(),
				},
				{
					id: "paste",
					label: t("panel.terminal.paste"),
					icon: ClipboardPaste,
					disabled: exited,
					shortcut: MAC ? "⌘V" : "⇧⌃V",
					onSelect: () => void paste(),
				},
				{
					id: "select-all",
					label: t("panel.terminal.selectAll"),
					icon: TextSelect,
					onSelect: () => handle.current?.terminal.selectAll?.(),
				},
				...(search
					? [
							{
								id: "find",
								label: t("panel.terminal.find.open"),
								icon: Search,
								shortcut: actionKbd("terminal.find", useUiStore.getState().keymapOverrides) || undefined,
								onSelect: () => setFinding(true),
							},
						]
					: []),
				...(menu?.panes ?? []).map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
				{
					id: "clear",
					label: t("panel.terminal.clear"),
					icon: Eraser,
					separatorBefore: true,
					onSelect: () => {
						const view = handle.current;
						void window.omp.terminal
							.request(tabId, { action: "clear", id })
							.then(() => {
								if (view && handle.current === view) clearScreen(view);
							})
							.catch(error => onError(String(error)));
					},
				},
				{
					id: "reset",
					label: t("panel.terminal.reset"),
					icon: RotateCcw,
					tooltip: t("panel.terminal.resetHint"),
					onSelect: () => {
						const view = handle.current;
						void window.omp.terminal
							.request(tabId, { action: "clear", id })
							.then(() => {
								if (view && handle.current === view) view.terminal.reset?.();
							})
							.catch(error => onError(String(error)));
					},
				},
				...(menu?.close ? [{ ...menu.close, separatorBefore: true }] : []),
			]
		: [];
	return (
		<div
			className="relative flex min-h-0 min-w-0 flex-1 flex-col"
			data-terminal-screen={id}
			onContextMenu={onContextMenu}
			onDragOver={event => {
				const types = [...event.dataTransfer.types];
				if (!types.includes("Files") && !types.includes(FILE_DRAG_TYPE)) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "copy";
			}}
			onDrop={event => void onDrop(event)}
			onFocusCapture={() => onFocusPane?.()}
			onMouseDownCapture={onMouseDownCapture}
		>
			<div
				aria-label={t("panel.terminal.title")}
				className={`min-h-0 min-w-0 flex-1 p-2 ${sized ? "overflow-hidden" : "overflow-auto"}`}
				data-terminal-viewport
				ref={element}
			/>
			{finding && search && (
				<TerminalFind
					onClose={() => {
						setFinding(false);
						handle.current?.terminal.focus();
					}}
					search={search}
				/>
			)}
			{menuAt && (
				<ContextMenu
					ariaLabel={t("panel.terminal.menu")}
					items={items}
					onClose={() => setMenuAt(null)}
					x={menuAt.x}
					y={menuAt.y}
				/>
			)}
		</div>
	);
}

/**
 * Each terminal's name on its tab (Orca FT2/FT8): the name a person gave it, else the program's own title, else its
 * shell's name; a name two tabs share gets their number.
 */
export function terminalLabels(
	sessions: readonly Pick<TerminalSnapshot, "id" | "title" | "shell">[],
	titles: Readonly<Record<string, string>>,
	fallback: (number: number) => string,
): string[] {
	const base = sessions.map(
		(session, index) => session.title || titles[session.id]?.trim() || session.shell || fallback(index + 1),
	);
	const seen = new Map<string, number>();
	return base.map(label => {
		if (base.filter(other => other === label).length < 2) return label;
		const count = (seen.get(label) ?? 0) + 1;
		seen.set(label, count);
		return `${label} ${count}`;
	});
}

/** Terminal requests (`ui.terminalNew`) each set has answered, across its mounts: the Terminal panel's and the quick terminal's. */
const terminalNewSeen = { panel: 0, scratch: 0 };

/**
 * One set of terminals: a tab's (the Terminal panel) or, with `scratch`, this window's quick terminal in the home folder
 * (`SCRATCH_TERMINAL_TAB`), which no session keeps.
 */
export function TerminalSet({ tabId, scratch = false }: { tabId: string; scratch?: boolean }) {
	const t = useT();
	const [sessions, setSessions] = useState<TerminalSnapshot[]>([]);
	const [layout, setLayout] = useState<TerminalPanes>(NO_PANES);
	const selected = focusedTerminal(layout);
	const select = useCallback((id: string | null) => setLayout(current => pickTerminal(current, id)), []);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const handles = useRef(new Map<string, { current: TerminalMount | null }>());
	const handleFor = (id: string) => {
		let handle = handles.current.get(id);
		if (!handle) {
			handle = { current: null };
			handles.current.set(id, handle);
		}
		return handle;
	};
	const tabsRef = useRef<HTMLDivElement>(null);
	/** The arrow keys switched sessions: the new shell leaves focus on the tab, so the next arrow moves on. */
	const keyboardSwitch = useRef(false);
	/** The tab (session id) or "new" (New terminal) that takes focus once a Delete's close has rendered. */
	const focusAfterClose = useRef<string | null>(null);
	const [shells, setShells] = useState<TerminalShell[]>([]);
	/** Titles the programs in the terminals set (OSC 0/2), by terminal. */
	const [titles, setTitles] = useState<Record<string, string>>({});
	const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
	const [closing, setClosing] = useState<{ index: number; fromKeys: boolean } | null>(null);
	const renameForm = useId();
	const expanded = useUiStore(s => s.terminalExpanded);
	const compact = useCompactShell();
	// A paired host's terminal answers over the network: typed characters are predicted (C109).
	const remote = useTabsStore(state => state.tabs.some(tab => tab.id === tabId && tab.device !== undefined));
	// A phone's key bar (Esc, Tab, sticky Ctrl/Alt, arrows, symbols) and its text size, 50–200 %.
	const touch = useShellInput() === "touch";
	const [keysOpen, setKeysOpen] = useState(() => currentShellMode() === "phone");
	const [fontScale, setFontScale] = useState(readFontScale);
	const [held, setHeld] = useState<HeldModifiers>({ ctrl: false, alt: false });
	const heldRef = useRef(held);
	heldRef.current = held;
	/** Another viewer sizes the active PTY (lease.ts): this screen draws it at that size until it claims. */
	const [lease, setLease] = useState<TerminalLeaseState | undefined>();
	const [claimTick, setClaimTick] = useState(0);
	const changeFont = useCallback((change: "smaller" | "larger" | "reset") => {
		setFontScale(scale => {
			const next = clampFontScale(
				change === "reset" ? FONT_SCALE_DEFAULT : scale + (change === "larger" ? 1 : -1) * FONT_SCALE_STEP,
			);
			try {
				window.localStorage.setItem(FONT_SCALE_KEY, String(next));
			} catch {
				// Storage may be blocked (private mode); the size still applies until the page closes.
			}
			return next;
		});
	}, []);
	/** Typed data with the held Ctrl/Alt applied; a single key spends them. */
	const transform = useCallback((data: string) => {
		const mods = heldRef.current;
		if (!mods.ctrl && !mods.alt) return data;
		if (isSingleKey(data)) {
			heldRef.current = { ctrl: false, alt: false };
			setHeld(heldRef.current);
		}
		return applyModifiers(data, mods);
	}, []);
	useEffect(() => {
		let live = true;
		void window.omp.terminal.shells(tabId).then(
			found => {
				if (live) setShells(found);
			},
			() => {},
		);
		return () => {
			live = false;
		};
	}, [tabId]);
	useLayoutEffect(() => {
		const target = focusAfterClose.current;
		if (target === null) return;
		focusAfterClose.current = null;
		const head = tabsRef.current?.parentElement;
		const next =
			target === "new"
				? head?.querySelector<HTMLElement>("[data-terminal-new]")
				: tabsRef.current?.querySelector<HTMLElement>(`[data-terminal-tab="${target}"]`);
		next?.focus();
	});
	const request = useCallback(
		async (operation: TerminalOperation) => {
			try {
				const result = await window.omp.terminal.request(tabId, operation);
				setSessions(result);
				setError(null);
				return result;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return null;
			}
		},
		[tabId],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries worker startup.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void (async () => {
			let result = await request({ action: "list", offsets: {} });
			if (cancelled) return;
			// A terminal asked for elsewhere (`ui.terminalNew`) starts once loading ends: no default shell beside it.
			const asked = useUiStore.getState().terminalNew;
			const pending =
				Boolean(asked.scratch) === scratch && asked.seq > terminalNewSeen[scratch ? "scratch" : "panel"];
			if (result?.length === 0 && !pending) {
				// Settings › General › Terminal shell; main ignores a path it no longer finds.
				const preferred = await window.omp.prefs.get(TERMINAL_SHELL_PREF).catch(() => undefined);
				if (cancelled) return;
				result = await request({
					action: "create",
					cols: 80,
					rows: 24,
					...(typeof preferred === "string" && preferred ? { shell: preferred } : {}),
				});
			}
			if (cancelled) return;
			select(result?.[0]?.id ?? null);
			setLoading(false);
		})();
		return () => {
			cancelled = true;
		};
	}, [request, attempt]);
	const onStatus = useCallback((snapshot: TerminalSnapshot) => {
		setSessions(previous => {
			const current = previous.find(item => item.id === snapshot.id);
			if (
				current?.exited === snapshot.exited &&
				current?.error === snapshot.error &&
				current?.exitCode === snapshot.exitCode &&
				current?.title === snapshot.title
			)
				return previous;
			return previous.map(item => (item.id === snapshot.id ? { ...snapshot, output: "" } : item));
		});
	}, []);
	// "Run in terminal" and /cleanse wrote to this session: show it once it is listed.
	const focusId = useUiStore(s => s.terminalFocusId);
	useEffect(() => {
		if (!focusId || !sessions.some(session => session.id === focusId)) return;
		select(focusId);
		useUiStore.setState({ terminalFocusId: null });
	}, [focusId, sessions, select]);
	const active = sessions.find(session => session.id === selected);
	/**
	 * A new terminal: shown in the pane in focus, or beside it with `split`. `ssh` runs a saved host in place of a shell;
	 * `input` is typed once it starts (the worker holds it until the shell is ready, D90).
	 */
	const add = async (
		shell?: string,
		split?: SplitDirection,
		extra: { ssh?: SshTarget; title?: string; input?: string | ((row: TerminalSnapshot) => string) } = {},
	) => {
		const preferred =
			extra.ssh || shell ? shell : await window.omp.prefs.get(TERMINAL_SHELL_PREF).catch(() => undefined);
		const result = await request({
			action: "create",
			cols: 80,
			rows: 24,
			...(typeof preferred === "string" && preferred ? { shell: preferred } : {}),
			...(extra.ssh ? { ssh: extra.ssh, title: extra.ssh.name } : {}),
			...(extra.title ? { title: extra.title } : {}),
		});
		const row = result?.at(-1);
		const created = row?.id;
		if (!row || !created) return;
		const input = typeof extra.input === "function" ? extra.input(row) : extra.input;
		if (input) void request({ action: "write", id: created, data: input });
		keyboardSwitch.current = false;
		setLayout(current => (split ? splitTerminal(current, created, split) : pickTerminal(current, created)));
	};
	// A terminal asked for elsewhere (the keymap's `terminal.new`, the palette, Settings › SSH), once this set can start one.
	const asked = useUiStore(s => s.terminalNew);
	const set = scratch ? "scratch" : "panel";
	// biome-ignore lint/correctness/useExhaustiveDependencies: a request is answered once, when the set can start a shell.
	useEffect(() => {
		if (loading || Boolean(asked.scratch) !== scratch || asked.seq <= terminalNewSeen[set]) return;
		terminalNewSeen[set] = asked.seq;
		void add(undefined, undefined, asked.ssh ? { ssh: asked.ssh } : {});
	}, [asked, loading]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a session just chosen starts with nobody known to hold its size.
	useEffect(() => {
		setLease(undefined);
		setClaimTick(0);
	}, [selected]);
	const sendKey = (key: TerminalKey) => {
		if (key.data === undefined || !selected) return;
		void request({ action: "write", id: selected, data: transform(key.data) });
	};
	const claim = async () => {
		if (!selected) return;
		if (await request({ action: "claim", id: selected })) {
			setLease("you");
			setClaimTick(tick => tick + 1);
		}
	};
	const activeId = selected ?? sessions[0]?.id ?? "";
	// A closed tab that was chosen gives its place to the session after it (the one before it when it was the last).
	// Closed from the keyboard (Delete on a tab), focus stays on the strip: the tab that took its place, or New terminal
	// when none is left. Closed by the pointer, the surviving terminal takes focus, as a click on a tab gives it.
	const closeNow = async (index: number, fromKeys: boolean) => {
		const id = sessions[index]?.id;
		if (!id) return;
		const result = await request({ action: "close", id });
		if (!result) return;
		handles.current.delete(id);
		const survivor = result[Math.min(index, result.length - 1)]?.id ?? null;
		setTitles(({ [id]: _, ...rest }) => rest);
		setLayout(current =>
			closeTerminal(
				current,
				id,
				result.map(session => session.id),
				survivor,
			),
		);
		if (id !== activeId) return;
		keyboardSwitch.current = fromKeys;
		if (fromKeys) focusAfterClose.current = survivor ?? "new";
	};
	/** A terminal running a command asks first (Orca FT22); one at its prompt, or ended, closes at once. */
	const close = async (index: number) => {
		const session = sessions[index];
		if (!session) return;
		const focused = document.activeElement;
		const fromKeys = focused?.getAttribute("role") === "tab" && tabsRef.current?.contains(focused) === true;
		if (session.exited) {
			await closeNow(index, fromKeys);
			return;
		}
		const { promise: deadline, resolve: giveUp } = Promise.withResolvers<null>();
		const timer = setTimeout(giveUp, BUSY_PROBE_MS, null);
		const answer = await Promise.race([
			window.omp.terminal.request(tabId, { action: "busy", id: session.id }).catch(() => null),
			deadline,
		]).finally(() => clearTimeout(timer));
		// No answer in time, an old host or an unreadable shell: as Orca, never end work nobody looked at.
		if (answer?.find(row => row.id === session.id)?.busy === false) await closeNow(index, fromKeys);
		else setClosing({ index, fromKeys });
	};
	const labels = terminalLabels(sessions, titles, number => t("panel.terminal.session", { number }));
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(
				(selected ? handles.current.get(selected)?.current?.terminal.getSelection() : "") ?? "",
			);
		} catch (cause) {
			setError(String(cause));
		}
	};
	const paste = async () => {
		try {
			if (selected) await request({ action: "write", id: selected, data: await navigator.clipboard.readText() });
		} catch (cause) {
			setError(String(cause));
		}
	};
	const rename = (id: string) => {
		const index = sessions.findIndex(session => session.id === id);
		setRenaming({ id, value: sessions[index]?.title ?? labels[index] ?? "" });
	};
	const tab = useTabsStore(state => state.tabs.find(item => item.id === tabId));
	// Saved commands of this tab's folder and every project's; the quick terminal (home folder) has every project's.
	const commands = useTerminalCommandsStore(state => state.commands);
	const folder = scratch ? undefined : tab?.cwd;
	const [commandsOpen, setCommandsOpen] = useState(false);
	useEffect(() => ensureTerminalCommands(), []);
	const runCommand = (command: string) => {
		if (selected && !active?.exited) void request({ action: "write", id: selected, data: commandInput(command) });
		else void add(undefined, undefined, { input: commandInput(command) });
	};
	const commandItems: ContextMenuItem[] = [
		...commandsFor(commands, folder).map(item => ({
			id: `run-${item.id}`,
			label: item.label,
			description: item.command,
			onSelect: () => runCommand(item.command),
		})),
		{
			id: "commands-edit",
			label: t(commands.length ? "panel.terminal.commands.manage" : "panel.terminal.commands.addFirst"),
			icon: Pencil,
			separatorBefore: commands.length > 0,
			onSelect: () => setCommandsOpen(true),
		},
	];
	// Orca's "Continue in terminal" (FC69): this computer's session, picked up by `omp --resume` in a new terminal.
	// While this tab holds the session, stock moves the terminal's run to a new file of its own (`open-elsewhere`).
	const sessionPath = !scratch && !remote ? tab?.sessionPath : undefined;
	const moreItems: ContextMenuItem[] = [
		...(shells.length > 1
			? shells.map(shell => ({
					id: shell.path,
					label: t("panel.terminal.newWith", { name: shell.name }),
					description: shell.path,
					onSelect: () => void add(shell.path),
				}))
			: []),
		...(sessionPath
			? [
					{
						id: "resume",
						label: t("panel.terminal.resume"),
						tooltip: t("panel.terminal.resumeHint"),
						icon: SquareTerminal,
						separatorBefore: shells.length > 1,
						onSelect: () =>
							void add(undefined, undefined, {
								// The program's own name, in every language.
								title: "omp",
								input: row =>
									commandInput(
										`omp --resume ${shellQuote(sessionPath, shellKindOf(row.shell, PLATFORM === "windows"))}`,
									),
							}),
					},
				]
			: []),
	];
	const split = layout.panes.length > 1;
	const menuFor = (id: string): TerminalMenuExtra => {
		const index = sessions.findIndex(session => session.id === id);
		return {
			panes: [
				{ id: "rename", label: t("panel.terminal.rename"), icon: Pencil, onSelect: () => rename(id) },
				...(split
					? [
							{
								id: "unsplit",
								label: t("panel.terminal.unsplit"),
								icon: Square,
								onSelect: () => setLayout(current => unsplit(pickTerminal(current, id))),
							},
						]
					: [
							{
								id: "split-right",
								label: t("panel.terminal.splitRight"),
								icon: Columns2,
								onSelect: () => void add(undefined, "right"),
							},
							{
								id: "split-down",
								label: t("panel.terminal.splitDown"),
								icon: Rows2,
								onSelect: () => void add(undefined, "down"),
							},
						]),
			],
			close: {
				id: "close",
				label: t("panel.terminal.closeTerminal"),
				icon: X,
				danger: true,
				onSelect: () => void close(index),
			},
		};
	};
	const pane = (id: string, index: number) => {
		const session = sessions.find(item => item.id === id);
		const focused = id === selected;
		return (
			<div
				className={cx(
					"flex min-h-0 min-w-0 flex-1 flex-col",
					index > 0 &&
						(layout.direction === "down" || compact
							? "border-t border-(--sc-divider)"
							: "border-l border-(--sc-divider)"),
				)}
				data-pane-focus={split && focused ? "" : undefined}
				data-terminal-pane={id}
				key={id}
			>
				<TerminalViewport
					claimTick={focused ? claimTick : 0}
					exited={Boolean(session?.exited)}
					fontSize={fontSizeFor(fontScale)}
					handle={handleFor(id)}
					id={id}
					key={`${id}:${attempt}`}
					menu={menuFor(id)}
					onError={setError}
					onFocusPane={() => {
						if (!focused) select(id);
					}}
					onLease={focused ? setLease : undefined}
					onStatus={onStatus}
					onTitle={title => setTitles(current => (current[id] === title ? current : { ...current, [id]: title }))}
					onZoom={changeFont}
					predict={remote}
					shell={session?.shell}
					tabId={tabId}
					takeFocus={focused && !keyboardSwitch.current}
					transform={transform}
				/>
			</div>
		);
	};
	const closingSession = closing ? sessions[closing.index] : undefined;
	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col bg-(--sc-surface-1)">
			<div
				className={cx(
					"flex min-h-(--sc-space-10) min-w-0 shrink-0 items-center border-b border-(--sc-divider) px-3 py-2",
					touch ? "gap-2.5 [--hit-gap-x:10px]" : "gap-1",
					// A phone's row of touch-sized buttons leaves the tabs no room: they take a row of their own.
					compact && "flex-wrap",
				)}
				data-terminal-head
			>
				<div className={cx("flex min-w-0 flex-1 items-center", compact && "basis-full")} ref={tabsRef}>
					<Tabs
						activeId={activeId}
						ariaLabel={t("panel.terminal.title")}
						className="min-w-0 flex-1"
						compact
						onChange={(id, via) => {
							keyboardSwitch.current = via === "key";
							select(id);
						}}
						tabs={sessions.map((session, index) => ({
							id: session.id,
							label: labels[index] ?? "",
							tooltip: labels[index],
							attrs: { "data-terminal-tab": session.id },
							className: "max-w-40",
							// Orca FT8 renames on a double click; a phone's long press opens the same menu (FM57).
							onDoubleClick: () => rename(session.id),
							onContextMenu: event => {
								event.preventDefault();
								rename(session.id);
							},
							onClose: () => void close(index),
							closeLabel: t("panel.terminal.closeFor", { name: labels[index] ?? "" }),
						}))}
						variant="pills"
					/>
				</div>
				<IconButton
					data-terminal-new
					icon={<Plus />}
					label={t("panel.terminal.new")}
					disabled={loading}
					onClick={() => void add()}
					size="sm"
				/>
				{moreItems.length > 0 && (
					<MenuButton
						data-terminal-more
						disabled={loading}
						icon={<ChevronDown />}
						items={moreItems}
						label={t("panel.terminal.newWithMenu")}
						size="sm"
					/>
				)}
				<MenuButton
					data-terminal-commands-menu
					disabled={loading}
					icon={<Bookmark />}
					items={commandItems}
					label={t("panel.terminal.commands.menu")}
					size="sm"
				/>
				<div className={cx("ml-auto flex shrink-0 items-center", touch ? "gap-2.5" : "gap-0.5")}>
					{touch && (
						<IconButton
							data-terminal-keys-toggle
							icon={<Keyboard />}
							label={t(keysOpen ? "panel.terminal.keysHide" : "panel.terminal.keysShow")}
							onClick={() => setKeysOpen(open => !open)}
							pressed={keysOpen}
							size="sm"
						/>
					)}
					<AddToChatButton
						disabled={!selected}
						read={() => (selected ? handles.current.get(selected)?.current?.terminal.getSelection() : "") ?? ""}
						tabId={tabId}
					/>
					<IconButton
						icon={<Copy />}
						label={t("panel.terminal.copy")}
						disabled={!selected}
						onClick={() => void copy()}
						size="sm"
					/>
					<IconButton
						icon={<ClipboardPaste />}
						label={t("panel.terminal.paste")}
						disabled={!selected || active?.exited}
						onClick={() => void paste()}
						size="sm"
					/>
					<IconButton
						icon={<Trash2 />}
						label={t("panel.terminal.clear")}
						disabled={!selected}
						onClick={() => {
							if (selected) {
								const view = handles.current.get(selected)?.current;
								void request({ action: "clear", id: selected }).then(result => {
									if (!result || !view || handles.current.get(selected)?.current !== view) return;
									clearScreen(view);
								});
							}
						}}
						size="sm"
					/>
					{!compact && !scratch && (
						<IconButton
							icon={expanded ? <Minimize2 /> : <Maximize2 />}
							label={t(expanded ? "fileViewer.collapse" : "fileViewer.expand")}
							onClick={() => useUiStore.setState({ terminalExpanded: !expanded })}
							pressed={expanded}
							size="sm"
						/>
					)}
				</div>
			</div>
			{error && (
				<Banner
					actions={
						<Button
							icon={<RotateCw />}
							onClick={() => setAttempt(value => value + 1)}
							size="sm"
							variant="secondary"
						>
							{t("common.retry")}
						</Button>
					}
					className="mx-3 mt-3"
					live
					title={t("panel.terminal.failed")}
					variant="danger"
				>
					<ErrorDetail error={error} />
				</Banner>
			)}
			{lease === "other" && (
				<div data-terminal-lease>
					<Banner
						actions={
							<Button data-terminal-lease-claim onClick={() => void claim()} size="sm" variant="secondary">
								{t("panel.terminal.lease.claim")}
							</Button>
						}
						className="mx-3 mt-3"
						live
					>
						{t("panel.terminal.lease.other")}
					</Banner>
				</div>
			)}
			{loading ? (
				<Spinner className="p-3" label={t("panel.terminal.starting")} size="sm" />
			) : selected ? (
				<div
					className={cx(
						"flex min-h-0 min-w-0 flex-1",
						layout.direction === "down" || compact ? "flex-col" : "flex-row",
					)}
					data-terminal-split={split ? layout.direction : undefined}
				>
					{layout.panes.map(pane)}
				</div>
			) : (
				<EmptyState
					icon={<TerminalIcon />}
					size="sm"
					title={t("panel.terminal.empty")}
					actions={
						<Button icon={<Plus />} onClick={() => void add()} size="sm" variant="secondary">
							{t("panel.terminal.new")}
						</Button>
					}
				/>
			)}
			{touch && keysOpen && selected && !loading && (
				<TerminalKeyBar
					disabled={Boolean(active?.exited)}
					fontScale={fontScale}
					held={held}
					onFontScale={changeFont}
					onKey={sendKey}
					onModifier={modifier => setHeld(previous => ({ ...previous, [modifier]: !previous[modifier] }))}
				/>
			)}
			{active?.exited && (
				<div
					role="status"
					className="flex min-w-0 shrink-0 items-start justify-between gap-2 border-t border-(--sc-border) px-3 py-2 text-sc-xs text-(--sc-text-muted)"
				>
					<span className="min-w-0 flex-1 break-words">
						{active.error || t("panel.terminal.exited", { code: active.exitCode ?? "—" })}
					</span>
					<Button
						icon={<RotateCw />}
						onClick={() => {
							if (selected) void request({ action: "restart", id: selected });
						}}
						size="sm"
					>
						{t("panel.terminal.restart")}
					</Button>
				</div>
			)}
			<ConfirmDialog
				confirmLabel={t("panel.terminal.closeRunning.confirm")}
				message={t("panel.terminal.closeRunning.message", {
					name: closing ? (labels[closing.index] ?? "") : "",
				})}
				onCancel={() => setClosing(null)}
				onConfirm={() => {
					const pending = closing;
					setClosing(null);
					if (pending && closingSession && sessions[pending.index]?.id === closingSession.id)
						void closeNow(pending.index, pending.fromKeys);
				}}
				open={closing !== null}
				title={t("panel.terminal.closeRunning.title")}
			/>
			<Modal
				footer={
					<>
						<Button onClick={() => setRenaming(null)} type="button" variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button form={renameForm} type="submit" variant="primary">
							{t("rename.submit")}
						</Button>
					</>
				}
				onClose={() => setRenaming(null)}
				open={renaming !== null}
				size="sm"
				title={t("panel.terminal.renameTitle")}
			>
				<form
					id={renameForm}
					onSubmit={event => {
						event.preventDefault();
						if (renaming) void request({ action: "rename", id: renaming.id, title: renaming.value });
						setRenaming(null);
					}}
				>
					<Input
						autoFocus
						hint={t("panel.terminal.renameHint")}
						label={t("panel.terminal.renameLabel")}
						maxLength={200}
						onChange={event => setRenaming(current => current && { ...current, value: event.target.value })}
						value={renaming?.value ?? ""}
					/>
				</form>
			</Modal>
			<TerminalCommandsDialog folder={folder} onClose={() => setCommandsOpen(false)} open={commandsOpen} />
		</div>
	);
}
export function TerminalPanel() {
	const t = useT();
	const tabId = useTabsStore(state => state.activeTabId);
	// A paired host's tab gets the host's terminals, in the tab's folder there (C114).
	if (!tabId) return <EmptyState icon={<TerminalIcon />} size="sm" title={t("panel.terminal.noTab")} />;
	return <TerminalSet key={tabId} tabId={tabId} />;
}
