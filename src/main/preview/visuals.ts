/**
 * C135/C141/C143: the agent's `gui_visualize` host tool. It shows a page, an
 * SVG or an image from the tab's folder, inline HTML it wrote, or a web address
 * in the user's Preview panel as a tab of its own, keeps a version per change
 * (`<userData>/visuals/<id>/v<N>.<ext>`) and every visual across launches
 * ("All visuals", `history.json`), reports the shown page's title and console
 * problems, and waits for the user to click one of the page's `data-choice`
 * elements with a real click (main/preview/host.ts gates it).
 *
 * Files load through `omp-visual://v<N>-<id>/<path>` on the window's visual
 * session only (main/preview/host.ts): the visual's entry file comes from its
 * snapshot, every other path from the entry file's folder, symlinks resolved
 * and never outside it.
 */

import * as path from "node:path";
import { z } from "zod";
import {
	type PreviewProblem,
	type PreviewVisualRecord,
	type PreviewVisualView,
	previewUrl,
	VISUAL_SCHEME,
} from "../../shared/preview";
import type { HostToolDefinition } from "../../shared/rpc-types";
import { core } from "../core/process";
import { type PreviewCheckOutcome, type PreviewImage, type PreviewVerdict, previewHint } from "./preview-check";
import { parseVisualUrl } from "./visual-navigation";

export const VISUALIZE_TOOL = "gui_visualize";
/** Visuals one tab keeps open at once. */
const TAB_VISUALS = 8;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const CHOICE_DEFAULT_SECONDS = 120;
const CHOICE_MAX_SECONDS = 600;

/**
 * The policy on every `omp-visual:` response. A visual's page loads only from its own origin (the entry and
 * the assets `VisualStore.resolve` allows) and from `data:`/`blob:`, so it cannot send what it reads to
 * another site by `fetch`, `sendBeacon`, `<a ping>`, a WebSocket, an image, a stylesheet, a prefetch, a form
 * or a frame. `default-src 'none'` is stricter than `'self'`: every allowed kind is named below. Inline script
 * and style stay (agent-written pages are one file) and so does `unsafe-eval`, which adds nothing to what
 * inline script can do. What CSP does not cover (navigation, popups, WebRTC) the visual session in
 * main/preview/host.ts refuses.
 */
const VISUAL_CSP = [
	"default-src 'none'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self' data: blob:",
	"worker-src 'self' blob:",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'self'",
	"form-action 'none'",
].join("; ");

export const VISUALIZE_DEFINITION: HostToolDefinition = {
	name: VISUALIZE_TOOL,
	label: "Visualize",
	description:
		"Show the user a page, SVG or image in OMPdesk's Preview panel beside the chat.\n" +
		"Show the user a page, SVG or image you made, or a web page, in OMPdesk's Preview panel beside the chat, and keep each change as a version they can flip through. " +
		"open: show `target` (a .html/.svg/image file inside the working directory, or an http(s) URL) or `html` (a complete HTML document you write); opening the same file, URL or visual id again adds a version. " +
		"The user can comment on elements or regions of the page and tweak its CSS variables; that feedback arrives as their next message. " +
		"check: the shown page's title and console errors. choose: wait for the user to click an element with a data-choice attribute in the page and return its value (use it to let them pick between options you drew). close: remove a visual.",
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["open", "check", "choose", "close"] },
			target: { type: "string", description: "open: file path (relative to the working directory) or http(s) URL." },
			html: { type: "string", description: "open: a complete HTML document instead of target." },
			label: { type: "string", description: "open: tab title; default the file name or page title." },
			visual: { type: "string", description: "Visual id from an earlier open (required for check, choose, close)." },
			timeout_seconds: {
				type: "integer",
				minimum: 10,
				maximum: CHOICE_MAX_SECONDS,
				description: `choose: how long to wait; default ${CHOICE_DEFAULT_SECONDS}.`,
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
};

const argsSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("open"),
		target: z.string().trim().min(1).max(4096).optional(),
		html: z.string().min(1).optional(),
		label: z.string().trim().min(1).max(120).optional(),
		visual: z.string().optional(),
	}),
	z.object({ action: z.literal("check"), visual: z.string() }),
	z.object({
		action: z.literal("choose"),
		visual: z.string(),
		timeout_seconds: z.number().int().min(10).max(CHOICE_MAX_SECONDS).optional(),
	}),
	z.object({ action: z.literal("close"), visual: z.string() }),
]);

interface VisualVersionRecord {
	version: number;
	createdAt: number;
	/** Snapshot file name in the visual's folder; "" for a web address. */
	file: string;
	hash: string;
}
interface VisualRecord {
	id: string;
	label: string;
	kind: "file" | "inline" | "url";
	/** Absolute file path or web address ("" inline). */
	target: string;
	cwd: string;
	/** Folder its other files load from (the tab folder, or the visual's own for inline HTML). */
	root: string;
	/** The entry's path under `root`, `/`-separated. */
	entry: string;
	createdAt: number;
	updatedAt: number;
	versions: VisualVersionRecord[];
}

interface OpenInput {
	target?: string;
	html?: string;
	label?: string;
	visual?: string;
}

interface OpenResult {
	record: VisualRecord;
	version: number;
	added: boolean;
}

class VisualError extends Error {}

interface VisualFile {
	file: string;
	type: string;
}

/** The visuals of this computer: records on disk, which tabs show which, and file serving for the scheme. */
export class VisualStore {
	readonly #dir: string;
	#records: VisualRecord[] = [];
	readonly #byTab = new Map<string, string[]>();
	#loaded: Promise<void> | null = null;
	#opening = Promise.resolve();

	constructor(dir: string) {
		this.#dir = dir;
	}

	#load(): Promise<void> {
		this.#loaded ??= core()
			.call<VisualRecord[]>("visual.history", { dir: this.#dir })
			.then(({ result }) => {
				this.#records = result;
			})
			.catch(error => {
				this.#loaded = null;
				throw error;
			});
		return this.#loaded;
	}

	#record(id: string): VisualRecord | undefined {
		return this.#records.find(record => record.id === id);
	}

	async list(): Promise<PreviewVisualRecord[]> {
		await this.#load();
		return this.#records.map(record => ({
			id: record.id,
			label: record.label,
			kind: record.kind,
			target: record.target,
			cwd: record.cwd,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			versions: record.versions.length,
		}));
	}

	forTab(tabId: string): string[] {
		return [...(this.#byTab.get(tabId) ?? [])];
	}

	/** Show a visual from "All visuals" in `tabId` too. */
	async addToTab(tabId: string, id: string): Promise<boolean> {
		await this.#load();
		if (!this.#record(id)) return false;
		const ids = this.#byTab.get(tabId) ?? [];
		if (!ids.includes(id)) this.#byTab.set(tabId, [...ids, id].slice(-TAB_VISUALS));
		return true;
	}

	removeFromTab(tabId: string, id: string): void {
		this.#byTab.set(
			tabId,
			(this.#byTab.get(tabId) ?? []).filter(entry => entry !== id),
		);
	}

	forgetTab(tabId: string): void {
		this.#byTab.delete(tabId);
	}

	view(id: string, version?: number): PreviewVisualView | null {
		const record = this.#record(id);
		if (!record) return null;
		const latest = record.versions.at(-1)?.version ?? 0;
		return {
			id,
			label: record.label,
			version: version && record.versions.some(entry => entry.version === version) ? version : latest,
			versions:
				record.kind === "url" ? [] : record.versions.map(({ version, createdAt }) => ({ version, createdAt })),
		};
	}

	/** The address a page loads for `version` (default latest). */
	url(id: string, version?: number): string | null {
		const record = this.#record(id);
		if (!record) return null;
		if (record.kind === "url") return record.target;
		const shown = this.view(id, version)?.version ?? 0;
		return `${VISUAL_SCHEME}://v${shown}-${id}/${record.entry.split("/").map(encodeURIComponent).join("/")}`;
	}

	/** Which visual and version an `omp-visual:` address names, or null. */
	parse(url: string): { id: string; version: number } | null {
		return parseVisualUrl(url);
	}

	/** The file an `omp-visual:` request reads, or null (unknown visual, outside its folder, missing). */
	async resolve(url: string): Promise<VisualFile | null> {
		return (await this.#file(url, false))?.result ?? null;
	}

	async #file(url: string, bytes: boolean) {
		await this.#load();
		const named = this.parse(url);
		const record = named && this.#record(named.id);
		if (!named || !record || record.kind === "url") return null;
		let relative: string;
		try {
			relative = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
		} catch {
			return null;
		}
		let source:
			| { kind: "snapshot"; dir: string; id: string; file: string }
			| { kind: "asset"; root: string; relative: string };
		if (relative === record.entry) {
			const file = record.versions.find(version => version.version === named.version)?.file;
			if (!file) return null;
			source = { kind: "snapshot", dir: this.#dir, id: record.id, file };
		} else if (record.kind === "file") {
			source = { kind: "asset", root: record.root, relative };
		} else {
			return null;
		}
		return core().call<VisualFile | null>("visual.file", { ...source, entry: record.entry, bytes });
	}

	/** The response for an `omp-visual:` request: the file `resolve` allows, or 404; both limited to the page's own origin. */
	async serve(url: string): Promise<Response> {
		const served = await this.#file(url, true).catch(() => null);
		const headers = {
			"Content-Security-Policy": VISUAL_CSP,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		};
		if (!served?.result || !(served.bin?.buffer instanceof ArrayBuffer)) {
			return new Response("Not found", {
				status: 404,
				headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
			});
		}
		const mime = served.result.type;
		const type = mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
		return new Response(served.bin.buffer, { headers: { ...headers, "Content-Type": type } });
	}

	/** `open`: a new visual or a new version of the tab's matching one. */
	open(tabId: string, cwd: string, input: OpenInput): Promise<OpenResult> {
		const opened = this.#opening.then(() => this.#open(tabId, cwd, input));
		this.#opening = opened.then(
			() => {},
			() => {},
		);
		return opened;
	}

	async #open(tabId: string, cwd: string, input: OpenInput): Promise<OpenResult> {
		await this.#load();
		if (Boolean(input.target) === Boolean(input.html)) throw new VisualError("Give either target or html");
		let source:
			| { kind: "inline" }
			| { kind: "url"; url: string; host: string }
			| { kind: "file"; raw: string; path: string };
		let bin: Buffer | undefined;
		const raw = input.target ?? "";
		if (input.html !== undefined) {
			if (Buffer.byteLength(input.html) > MAX_HTML_BYTES) throw new VisualError("html is larger than 2 MB");
			source = { kind: "inline" };
			bin = Buffer.from(input.html);
		} else if (/^https?:\/\//i.test(raw)) {
			const url = previewUrl(raw);
			if (!url) throw new VisualError(`Not a web address the preview opens: ${raw}`);
			source = { kind: "url", url, host: new URL(url).host };
		} else {
			source = { kind: "file", raw, path: path.resolve(cwd, raw) };
		}
		const tabIds = this.#byTab.get(tabId) ?? [];
		const { result } = await core()
			.call<OpenResult & { evicted: string[] }>(
				"visual.open",
				{
					dir: this.#dir,
					cwd,
					label: input.label,
					visual: input.visual,
					tabIds,
					tabLimit: TAB_VISUALS,
					input: source,
				},
				{ bin },
			)
			.catch(error => {
				this.#loaded = null;
				throw error;
			});
		const { record, added, version, evicted } = result;
		this.#records = [record, ...this.#records.filter(old => old.id !== record.id && !evicted.includes(old.id))];
		if (!tabIds.includes(record.id)) this.#byTab.set(tabId, [...(this.#byTab.get(tabId) ?? []), record.id]);
		return { record, version, added };
	}
}

/** The user's `data-choice` pick, or why there is none. */
export type VisualChoice = { value: string; text: string } | "none" | "timeout" | "closed" | "agent";

/** What the preview reports about the page that shows a visual (main/preview/host.ts). */
export interface VisualPages {
	/** Close every preview tab showing it. */
	close(visualId: string): void;
	/** The first page showing it, or null when none is on screen. */
	inspect(visualId: string): { title: string; url: string; loading: boolean; problems: PreviewProblem[] } | null;
	/**
	 * Wait for a real click on one of its page's `data-choice` elements: the choice, or why there is none
	 * (`none` = no page shows it, `agent` = the agent's browser drives that page).
	 */
	choose(visualId: string, timeoutMs: number): Promise<VisualChoice>;
	/**
	 * The PNG of the one page showing `version` of the visual (the page only, never the window), once it is on screen,
	 * loaded and settled; null when none is within `budgetMs`, or when no window has put it on screen within
	 * `appearMs` (preview-check.ts).
	 */
	capture(visualId: string, version: number, budgetMs: number, appearMs: number): Promise<PreviewImage | null>;
	/** A quiet notice on the page showing `version` of the visual: what the judge saw. */
	flag(visualId: string, version: number, problem: PreviewVerdict): void;
}

export interface VisualizeContext {
	tabId: string;
	cwd: string;
	store: VisualStore;
	pages: VisualPages;
	/** Ask the tab's window to show the visual (it opens when the tab is in front, or when the user goes there). */
	reveal(visualId: string): void;
	/**
	 * The Preview check of the page just opened (preview-check.ts): what the judge model saw on it, `"unchecked"` when
	 * a native judge was there but the page went unjudged, or null (no check, or nothing wrong seen). Never rejects and
	 * answers within a few seconds. Unset (a test) = no check and no hint.
	 */
	check?(visualId: string, version: number): Promise<PreviewCheckOutcome | null>;
}

/** Run one `gui_visualize` call: the text the agent reads, and whether it failed. */
export async function runVisualizeTool(
	context: VisualizeContext,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const parsed = argsSchema.safeParse(args);
	if (!parsed.success) return { text: `Invalid gui_visualize arguments: ${parsed.error.message}`, isError: true };
	const request = parsed.data;
	try {
		if (request.action === "open") {
			const { record, version, added } = await context.store.open(context.tabId, context.cwd, request);
			context.reveal(record.id);
			const versionText = record.kind === "url" ? "" : `, version ${version}${added ? "" : " (unchanged)"}`;
			const problem = (await context.check?.(record.id, version)) ?? null;
			return {
				text:
					`Showing "${record.label}" in the user's Preview panel (visual ${record.id}${versionText}). ` +
					"The user may comment on it; their comments come as a message." +
					(problem ? `\n${previewHint(problem)}` : ""),
				isError: false,
			};
		}
		if (!context.store.forTab(context.tabId).includes(request.visual))
			return { text: `No visual ${request.visual} in this tab`, isError: true };
		if (request.action === "close") {
			context.store.removeFromTab(context.tabId, request.visual);
			context.pages.close(request.visual);
			return { text: `Closed visual ${request.visual}.`, isError: false };
		}
		if (request.action === "check") {
			const page = context.pages.inspect(request.visual);
			if (!page)
				return {
					text: "The visual is not on screen now (its tab or the Preview panel is closed).",
					isError: false,
				};
			const problems = page.problems.length
				? page.problems
						.map(
							problem =>
								`- ${problem.level}: ${problem.message}${problem.source ? ` (${problem.source}:${problem.line})` : ""}`,
						)
						.join("\n")
				: "No console errors or warnings.";
			return {
				text: `Title: ${page.title || "(none)"}\nAddress: ${page.url}${page.loading ? "\nStill loading." : ""}\n${problems}`,
				isError: false,
			};
		}
		const timeoutMs = (request.timeout_seconds ?? CHOICE_DEFAULT_SECONDS) * 1000;
		const choice = await context.pages.choose(request.visual, timeoutMs);
		if (choice === "none")
			return { text: "The visual is not on screen, so the user cannot choose now.", isError: true };
		if (choice === "agent")
			return { text: "Your browser tool is driving that page; choices count only from the user.", isError: true };
		if (choice === "timeout") return { text: "The user did not choose in time.", isError: false };
		if (choice === "closed") return { text: "The visual was closed before the user chose.", isError: false };
		return { text: `The user chose "${choice.value}"${choice.text ? ` (${choice.text})` : ""}.`, isError: false };
	} catch (error) {
		return { text: error instanceof Error ? error.message : String(error), isError: true };
	}
}
