/**
 * Wave A1 tests: inline visual directive parsing (`::orca-visual` / `::momo-visual` + fenced
 * visuals), CSP/theme/height-governor shell hardening, and lazy `InlineVisualCard` rendering.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import {
	hasVisualDirective,
	isValidVisualFileName,
	MAX_VISUAL_DIRECTIVES_PER_MESSAGE,
	parseVisualDirectiveLine,
	splitMarkdownVisualSegments,
	stripVisualDirectiveLines,
	withoutPendingVisualDirectiveTail,
} from "./inline-visual-directive";
import {
	buildInertHtmlPreviewSrcDoc,
	buildSandboxedVisualSrcDoc,
	buildVisualThemeCss,
	createHeightGovernor,
	INERT_HTML_PREVIEW_CSP,
	isHtmlDocumentCodeBlock,
	VISUAL_IFRAME_CSP,
	VISUAL_MAX_HEIGHT,
	VISUAL_MIN_HEIGHT,
} from "./inline-visual-shell";

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

const { createRoot } = await import("react-dom/client");
const { InlineVisualCard, HtmlCodePreview } = await import("./InlineVisualCard");

let root: Root | null = null;
let container: Element | null = null;

async function mount(element: ReactElement): Promise<Element> {
	const host = document.createElement("div") as unknown as Element;
	document.body.appendChild(host as never);
	container = host;
	root = createRoot(host);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	return host;
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	container?.remove();
	container = null;
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("inline-visual-directive parser", () => {
	it("parses valid ::orca-visual and ::momo-visual standalone lines", () => {
		expect(parseVisualDirectiveLine('::orca-visual{file="chart.html" title="Latency"}')).toEqual({
			kind: "file",
			prefix: "orca",
			file: "chart.html",
			title: "Latency",
			raw: '::orca-visual{file="chart.html" title="Latency"}',
		});
		expect(parseVisualDirectiveLine('  ::momo-visual{file="report-2026.html"}  ')).toEqual({
			kind: "file",
			prefix: "momo",
			file: "report-2026.html",
			raw: '::momo-visual{file="report-2026.html"}',
		});
	});

	it("rejects path traversal, subdirectories, non-html files, Windows device names, and unknown attributes", () => {
		for (const bad of [
			"../secret.html",
			"dir/chart.html",
			"dir\\chart.html",
			".hidden.html",
			"script.js",
			".html",
			"CON.html",
			"nul.html",
			"COM1.html",
		]) {
			expect(isValidVisualFileName(bad)).toBe(false);
			expect(parseVisualDirectiveLine(`::orca-visual{file="${bad}"}`)).toBeNull();
		}
		expect(parseVisualDirectiveLine('::orca-visual{file="ok.html" extra="1"}')).toBeNull();
		expect(parseVisualDirectiveLine('::orca-visual{file="ok.html" file="dup.html"}')).toBeNull();
		expect(parseVisualDirectiveLine('::orca-visual{title="missing-file"}')).toBeNull();
	});

	it("splits prose and directives while keeping directives inside normal code fences literal", () => {
		const md = [
			"Intro text.",
			"",
			"```markdown",
			'::orca-visual{file="example.html" title="In Fence"}',
			"```",
			"",
			'::orca-visual{file="real.html" title="Real Chart"}',
			"",
			"Closing prose.",
		].join("\n");

		expect(hasVisualDirective(md)).toBe(true);
		const segments = splitMarkdownVisualSegments(md);
		expect(segments).toHaveLength(3);
		expect(segments[0]?.kind).toBe("markdown");
		expect(segments[0]?.kind === "markdown" && segments[0].content).toContain('::orca-visual{file="example.html"');
		expect(segments[1]).toEqual({
			kind: "visual",
			spec: {
				kind: "file",
				prefix: "orca",
				file: "real.html",
				title: "Real Chart",
				raw: '::orca-visual{file="real.html" title="Real Chart"}',
			},
		});
		expect(segments[2]).toEqual({ kind: "markdown", content: "Closing prose." });
	});

	it("parses fenced ```orca-visual and ```momo-visual inline HTML snippets", () => {
		const md = ["Summary:", '```momo-visual title="Inline Metric"', "<div class='card'>42ms</div>", "```"].join("\n");
		const segments = splitMarkdownVisualSegments(md);
		expect(segments).toHaveLength(2);
		expect(segments[1]).toMatchObject({
			kind: "visual",
			spec: {
				kind: "inline",
				prefix: "momo",
				title: "Inline Metric",
				html: "<div class='card'>42ms</div>",
			},
		});
	});

	it("caps directives per message at MAX_VISUAL_DIRECTIVES_PER_MESSAGE", () => {
		const lines = Array.from(
			{ length: MAX_VISUAL_DIRECTIVES_PER_MESSAGE + 3 },
			(_, idx) => `::orca-visual{file="chart-${idx}.html"}`,
		).join("\n");
		const segments = splitMarkdownVisualSegments(lines);
		const visuals = segments.filter(s => s.kind === "visual");
		expect(visuals).toHaveLength(MAX_VISUAL_DIRECTIVES_PER_MESSAGE);
	});

	it("suppresses incomplete trailing directives while streaming and strips completed lines on copy", () => {
		expect(withoutPendingVisualDirectiveTail('Done.\n::orca-visual{file="chart.ht')).toBe("Done.");
		expect(withoutPendingVisualDirectiveTail("```md\n::orca-visual{file=")).toBe("```md\n::orca-visual{file=");
		expect(stripVisualDirectiveLines('Before\n\n::orca-visual{file="a.html" title="Chart"}\n\nAfter')).toBe(
			"Before\n\nAfter",
		);
	});
});

describe("inline-visual-shell security and height governor", () => {
	it("injects base href, strict CSP, theme variables, and channel bootstrap into srcDoc", () => {
		const css = buildVisualThemeCss({
			scheme: "dark",
			bg: "#111111",
			surface1: "#181818",
			surface2: "#222222",
			elevated: "#1d1d1d",
			codeBg: "#161616",
			text: "#f4f4f5",
			textSecondary: "#d4d4d8",
			textMuted: "#a1a1aa",
			textSubtle: "#71717a",
			border: "#333333",
			borderSubtle: "#27272a",
			divider: "#27272a",
			accent: "#60a5fa",
			success: "#4ade80",
			warning: "#fbbf24",
			danger: "#f87171",
			fontSans: "Geist Variable, sans-serif",
			fontMono: "SF Mono, monospace",
			radiusSm: "6px",
			radiusMd: "8px",
			radiusLg: "10px",
		});
		const doc = buildSandboxedVisualSrcDoc({
			html: '<!doctype html><html><head><base href="https://evil.example/"></head><body><h1>Hi</h1></body></html>',
			channel: "deadbeef",
			themeCss: css,
		});
		expect(doc).toContain('<base href="about:srcdoc">');
		expect(doc).not.toContain("https://evil.example/");
		expect(doc).toContain(VISUAL_IFRAME_CSP);
		expect(doc).toContain("color-scheme: dark;");
		expect(doc).toContain("--sc-accent: #60a5fa;");
		expect(doc).toContain("--primary: #60a5fa;");
		expect(doc).toContain("omp-visual:resize");
		expect(doc).toContain('"deadbeef"');
	});

	it("governs height bounds and freezes runaway growth loops", () => {
		const gov = createHeightGovernor(200);
		expect(gov.accept(20, 1000)).toEqual({ height: VISUAL_MIN_HEIGHT, frozen: false });
		expect(gov.accept(9999, 1050)).toEqual({ height: VISUAL_MAX_HEIGHT, frozen: false });

		gov.reset();
		let decision = { height: 200, frozen: false };
		for (let i = 1; i <= 15; i++) {
			decision = gov.accept(200 + i * 25, 2000 + i * 50);
		}
		expect(decision.frozen).toBe(true);
		const frozenHeight = decision.height;
		expect(gov.accept(900, 3000)).toEqual({ height: frozenHeight, frozen: true });
	});

	it("detects full HTML code documents and strips scripts in inert preview srcDoc", () => {
		expect(isHtmlDocumentCodeBlock("<!doctype html><html><body>hi</body></html>")).toBe(true);
		expect(isHtmlDocumentCodeBlock("<div>partial</div>")).toBe(false);
		const inert = buildInertHtmlPreviewSrcDoc(
			"<!doctype html><html><body><script>alert(1)</script><p>Safe</p></body></html>",
			":root { color-scheme: light; }",
		);
		expect(inert).toContain(INERT_HTML_PREVIEW_CSP);
		expect(inert).not.toContain("alert(1)");
		expect(inert).toContain("<p>Safe</p>");
	});
});

describe("InlineVisualCard & HtmlCodePreview rendering", () => {
	it("renders inline visual with sandbox='allow-scripts', no-referrer, FigureHeader, and Preview/Code toggle", async () => {
		const host = await mount(
			<InlineVisualCard
				spec={{
					kind: "inline",
					prefix: "orca",
					title: "Latency Breakdown",
					html: "<div>Chart Body</div>",
					raw: "",
				}}
			/>,
		);
		const header = host.querySelector("[data-figure-header]");
		expect(header).not.toBeNull();
		expect(host.querySelector("[data-figure-title]")?.textContent).toBe("Latency Breakdown");

		const iframe = host.querySelector("iframe[data-visual-frame='inline']");
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
		expect(iframe?.getAttribute("referrerpolicy") ?? iframe?.getAttribute("referrerPolicy")).toBe("no-referrer");
		const srcDoc = iframe?.getAttribute("srcdoc") ?? iframe?.getAttribute("srcDoc") ?? "";
		expect(srcDoc).toContain("Chart Body");
		expect(srcDoc).toContain(VISUAL_IFRAME_CSP);

		// Toggle to Code view and verify source renders inside CodeBlock
		const codeBtn = host.querySelector('[data-figure-mode-button="code"]') as HTMLElement | null;
		expect(codeBtn).not.toBeNull();
		await act(async () => {
			codeBtn?.click();
		});
		expect(host.querySelector("iframe[data-visual-frame='inline']")).toBeNull();
		expect(host.textContent).toContain("Chart Body");
	});

	it("loads file-backed ::orca-visual via window.omp.fs.read", async () => {
		(window as unknown as { omp?: unknown }).omp = {
			fs: {
				read: async (filePath: string) =>
					filePath === "bench.html"
						? { ok: true, content: "<div>Loaded From FS</div>", truncated: false, binary: false, size: 22 }
						: { ok: false, content: "", truncated: false, binary: false, size: 0 },
			},
		};
		const host = await mount(
			<InlineVisualCard
				spec={{
					kind: "file",
					prefix: "orca",
					file: "bench.html",
					title: "Benchmark",
					raw: '::orca-visual{file="bench.html" title="Benchmark"}',
				}}
			/>,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const iframe = host.querySelector("iframe[data-visual-frame='inline']");
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("srcdoc") ?? iframe?.getAttribute("srcDoc")).toContain("Loaded From FS");
		expect(host.querySelector("[data-visual-open-file]")).not.toBeNull();
	});

	it("renders HtmlCodePreview strictly inert with sandbox=''", async () => {
		const host = await mount(<HtmlCodePreview code="<!doctype html><html><body><p>Preview</p></body></html>" />);
		const iframe = host.querySelector("iframe");
		expect(iframe).not.toBeNull();
		expect(iframe?.getAttribute("sandbox")).toBe("");
		expect(iframe?.getAttribute("referrerpolicy") ?? iframe?.getAttribute("referrerPolicy")).toBe("no-referrer");
	});
});
