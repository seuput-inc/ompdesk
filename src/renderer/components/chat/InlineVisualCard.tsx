/**
 * Sandboxed inline HTML visual card (Orca's `NativeChatInlineVisual` + `NativeChatVisualFrame`, MIT)
 * and inert HTML code-fence preview (`NativeChatHtmlPreview`).
 *
 * Loaded lazily via `React.lazy` whenever a reply contains `::orca-visual{...}`,
 * `::momo-visual{...}`, a fenced `orca-visual`/`momo-visual` block, or an HTML code preview.
 */

import { FileCode2, Maximize2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { Card, CopyButton, IconButton, Modal, Skeleton } from "../common";
import { CodeBlock } from "./CodeBlock";
import { type FigureMode, FigureModeToggle } from "./Figure";
import { FigureHeader } from "./FigureHeader";
import type { InlineVisualSpec } from "./inline-visual-directive";
import {
	buildInertHtmlPreviewSrcDoc,
	buildSandboxedVisualSrcDoc,
	buildVisualThemeCss,
	createHeightGovernor,
	generateVisualChannel,
	VISUAL_DEFAULT_HEIGHT,
	type VisualThemeTokens,
} from "./inline-visual-shell";

const MAX_VISUAL_FILE_BYTES = 512 * 1024;
const INERT_PREVIEW_HEIGHT_PX = 280;

function readVisualThemeTokens(): VisualThemeTokens {
	if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
		return {
			scheme: "dark",
			bg: "",
			surface1: "",
			surface2: "",
			elevated: "",
			codeBg: "",
			text: "",
			textSecondary: "",
			textMuted: "",
			textSubtle: "",
			border: "",
			borderSubtle: "",
			divider: "",
			accent: "",
			success: "",
			warning: "",
			danger: "",
			fontSans: "",
			fontMono: "",
			radiusSm: "",
			radiusMd: "",
			radiusLg: "",
		};
	}
	const root = document.documentElement;
	const style = window.getComputedStyle(root);
	const read = (name: string) => style.getPropertyValue(name).trim();
	const attr = root.getAttribute("data-theme");
	const scheme: "dark" | "light" =
		attr === "light" || attr === "dark"
			? attr
			: typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches
				? "light"
				: "dark";

	return {
		scheme,
		bg: read("--sc-bg"),
		surface1: read("--sc-surface-1"),
		surface2: read("--sc-surface-2"),
		elevated: read("--sc-elevated"),
		codeBg: read("--sc-code-bg"),
		text: read("--sc-text"),
		textSecondary: read("--sc-text-secondary"),
		textMuted: read("--sc-text-muted"),
		textSubtle: read("--sc-text-subtle"),
		border: read("--sc-border"),
		borderSubtle: read("--sc-border-subtle"),
		divider: read("--sc-divider"),
		accent: read("--sc-accent"),
		success: read("--sc-success"),
		warning: read("--sc-warning"),
		danger: read("--sc-danger"),
		fontSans: read("--sc-font-sans"),
		fontMono: read("--sc-font-mono"),
		radiusSm: read("--sc-radius-sm"),
		radiusMd: read("--sc-radius-md"),
		radiusLg: read("--sc-radius-lg"),
	};
}

/** Track the active OMPdesk theme as a CSS string forwarded into sandboxed iframes. */
function useVisualThemeCss(): string {
	const [css, setCss] = useState(() => buildVisualThemeCss(readVisualThemeTokens()));

	useEffect(() => {
		if (typeof MutationObserver === "undefined") return;
		const update = () => {
			const next = buildVisualThemeCss(readVisualThemeTokens());
			setCss(prev => (prev === next ? prev : next));
		};
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "data-theme-name", "style", "class"],
		});
		return () => observer.disconnect();
	}, []);

	return css;
}

interface VisualFrameProps {
	html: string;
	title: string;
	themeCss: string;
	fillModal?: boolean;
}

/** Sandboxed iframe host (`sandbox="allow-scripts"`) with live theme sync and auto-height governor. */
function SandboxedVisualFrame({ html, title, themeCss, fillModal = false }: VisualFrameProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [channel] = useState(generateVisualChannel);
	const [height, setHeight] = useState(VISUAL_DEFAULT_HEIGHT);
	const governorRef = useRef(createHeightGovernor(VISUAL_DEFAULT_HEIGHT));

	// Freeze the initial theme CSS baked into srcDoc per html payload; subsequent theme switches
	// push over postMessage so interactive chart state never reloads on theme flip.
	const latestThemeCssRef = useRef(themeCss);
	latestThemeCssRef.current = themeCss;

	const srcDoc = useMemo(() => {
		governorRef.current.reset();
		return buildSandboxedVisualSrcDoc({ html, channel, themeCss: latestThemeCssRef.current });
	}, [html, channel]);

	useEffect(() => {
		const win = iframeRef.current?.contentWindow;
		if (!win) return;
		win.postMessage({ type: "omp-visual:theme", channel, css: themeCss }, "*");
	}, [channel, themeCss]);

	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			const frameWindow = iframeRef.current?.contentWindow;
			if (!frameWindow || event.source !== frameWindow) return;
			const data = event.data as Record<string, unknown> | null;
			if (!data || typeof data !== "object" || data.channel !== channel) return;
			if (data.type === "omp-visual:resize" && typeof data.height === "number" && !fillModal) {
				const decision = governorRef.current.accept(data.height);
				setHeight(prev => (prev === decision.height ? prev : decision.height));
			} else if (
				data.type === "omp-visual:open-link" &&
				typeof data.href === "string" &&
				/^https?:\/\//i.test(data.href)
			) {
				openExternal(data.href);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [channel, fillModal]);

	const handleLoad = useCallback(() => {
		const win = iframeRef.current?.contentWindow;
		if (!win) return;
		win.postMessage({ type: "omp-visual:theme", channel, css: latestThemeCssRef.current }, "*");
		win.postMessage({ type: "omp-visual:ping", channel }, "*");
	}, [channel]);

	return (
		<iframe
			className={cx("omp-inline-visual-frame", fillModal && "omp-inline-visual-modal-frame")}
			data-visual-frame={fillModal ? "modal" : "inline"}
			onLoad={handleLoad}
			ref={iframeRef}
			referrerPolicy="no-referrer"
			sandbox="allow-scripts"
			srcDoc={srcDoc}
			style={fillModal ? undefined : { height: `${height}px` }}
			title={title}
		/>
	);
}

interface LoadedVisualState {
	status: "loading" | "ready" | "error";
	html: string;
	resolvedPath?: string;
}

export interface InlineVisualCardProps {
	spec: InlineVisualSpec;
	className?: string;
}

/**
 * Interactive sandboxed HTML visual card rendered inline in a chat turn.
 * Uses the unified single-row `FigureHeader` with Preview/Code toggle, Copy,
 * Open file (for file-backed visuals), and Fullscreen modal expand.
 */
export const InlineVisualCard = memo(function InlineVisualCard({ spec, className }: InlineVisualCardProps) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const themeCss = useVisualThemeCss();
	const [mode, setMode] = useState<FigureMode>("preview");
	const [expanded, setExpanded] = useState(false);

	const [loaded, setLoaded] = useState<LoadedVisualState>(() =>
		spec.kind === "inline" ? { status: "ready", html: spec.html } : { status: "loading", html: "" },
	);

	useEffect(() => {
		if (spec.kind === "inline") {
			setLoaded({ status: "ready", html: spec.html });
			return;
		}
		let cancelled = false;
		setLoaded({ status: "loading", html: "" });

		const readFile = async () => {
			const fsApi = typeof window !== "undefined" ? window.omp?.fs : undefined;
			if (!fsApi?.read) {
				if (!cancelled) setLoaded({ status: "error", html: "" });
				return;
			}
			const candidates = [spec.file, `.omp/visuals/${spec.file}`];
			for (const candidate of candidates) {
				try {
					const res = await fsApi.read(candidate, MAX_VISUAL_FILE_BYTES, tabId ?? undefined);
					if (res?.ok && !res.binary && typeof res.content === "string" && res.content.trim().length > 0) {
						if (!cancelled) setLoaded({ status: "ready", html: res.content, resolvedPath: candidate });
						return;
					}
				} catch {
					// Try next candidate path before marking unavailable.
				}
			}
			if (!cancelled) setLoaded({ status: "error", html: "" });
		};

		void readFile();
		return () => {
			cancelled = true;
		};
	}, [spec, tabId]);

	const title = spec.title ?? (spec.kind === "file" ? spec.file : "Visual");
	const canOpenFile = spec.kind === "file" && (loaded.resolvedPath ?? spec.file);

	const openInViewer = () => {
		if (!canOpenFile) return;
		useUiStore.getState().openFilePreview(canOpenFile);
	};

	if (loaded.status === "loading") {
		return (
			<div className={cx("omp-inline-visual", className)} data-figure="visual" data-visual-state="loading">
				<Card className="overflow-hidden text-(--sc-text)" padding="none" surface="1">
					<FigureHeader title={title} />
					<div className="p-4">
						<Skeleton className="h-44 w-full rounded-(--sc-radius-md)" />
					</div>
				</Card>
			</div>
		);
	}

	if (loaded.status === "error") {
		return (
			<div className={cx("omp-inline-visual", className)} data-figure="visual" data-visual-state="unavailable">
				<Card className="overflow-hidden text-(--sc-text)" padding="none" surface="1">
					<FigureHeader title={title}>
						{canOpenFile && (
							<IconButton
								data-visual-open-file
								icon={<FileCode2 />}
								label={t("tools.path.open")}
								onClick={openInViewer}
								size="sm"
							/>
						)}
					</FigureHeader>
					<div className="px-3.5 py-3 text-sc-sm text-(--sc-text-muted)">
						<span className="font-mono text-sc-xs text-(--sc-text-secondary)">
							{spec.kind === "file" ? spec.file : title}
						</span>
					</div>
				</Card>
			</div>
		);
	}

	const toggle = <FigureModeToggle mode={mode} onChange={setMode} />;

	return (
		<div
			className={cx("omp-inline-visual", className)}
			data-figure="visual"
			data-visual-kind={spec.kind}
			data-visual-state="ready"
		>
			{mode === "code" ? (
				<CodeBlock
					code={loaded.html}
					endActions={
						canOpenFile ? (
							<IconButton
								data-visual-open-file
								icon={<FileCode2 />}
								label={t("tools.path.open")}
								onClick={openInViewer}
								size="sm"
							/>
						) : undefined
					}
					headerActions={toggle}
					language="html"
					maxHeightClass="max-h-96"
					showWrap
					title={title}
				/>
			) : (
				<Card className="overflow-hidden text-(--sc-text)" padding="none" surface="1">
					<FigureHeader title={title}>
						{toggle}
						<CopyButton label={t("chat.copyCode")} text={loaded.html} />
						{canOpenFile && (
							<IconButton
								data-visual-open-file
								icon={<FileCode2 />}
								label={t("tools.path.open")}
								onClick={openInViewer}
								size="sm"
							/>
						)}
						<IconButton
							data-figure-expand
							icon={<Maximize2 />}
							label={t("figure.expand")}
							onClick={() => setExpanded(true)}
							size="sm"
						/>
					</FigureHeader>
					<div className="omp-inline-visual-stage">
						<SandboxedVisualFrame html={loaded.html} themeCss={themeCss} title={title} />
					</div>
				</Card>
			)}
			<Modal
				bodyClassName="flex min-h-0 flex-1 flex-col p-0"
				onClose={() => setExpanded(false)}
				open={expanded}
				size="full"
				title={title}
			>
				{expanded ? <SandboxedVisualFrame fillModal html={loaded.html} themeCss={themeCss} title={title} /> : null}
			</Modal>
		</div>
	);
});

/**
 * Inert HTML document preview for ```html code fences (Wave A3): strictly `sandbox=""`
 * (no scripts, no network) with theme token forwarding. Shared in this lazy chunk so
 * `CodeBlock` adds zero eager bytes to the first-screen bundle.
 */
export function HtmlCodePreview({ code, title = "HTML" }: { code: string; title?: string }) {
	const themeCss = useVisualThemeCss();
	const srcDoc = useMemo(() => buildInertHtmlPreviewSrcDoc(code, themeCss), [code, themeCss]);
	return (
		<div className="omp-inline-visual-stage" data-html-code-preview>
			<iframe
				className="omp-inline-visual-frame"
				referrerPolicy="no-referrer"
				sandbox=""
				srcDoc={srcDoc}
				style={{ height: `${INERT_PREVIEW_HEIGHT_PX}px` }}
				title={title}
			/>
		</div>
	);
}

export default InlineVisualCard;
