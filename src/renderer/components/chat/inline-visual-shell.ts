/**
 * Sandboxed HTML visual iframe shell, CSP builder, theme token bridge, and auto-height
 * governor (adapted from Orca's `native-chat-visual-shell.ts` and
 * `native-chat-visual-height-governor.ts`, MIT).
 *
 * Loaded lazily alongside `InlineVisualCard` so none of this code enters the first-screen bundle.
 */

export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
export const VISUAL_DEFAULT_HEIGHT = 240;

const RUNAWAY_INCREASE_LIMIT = 12;
const RUNAWAY_WINDOW_MS = 3_000;
const RATE_LIMIT_REPORTS = 30;
const RATE_LIMIT_WINDOW_MS = 1_000;

/**
 * Strict CSP for sandboxed interactive visuals (`sandbox="allow-scripts"`):
 * - No network exfiltration (`connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`)
 * - No nested frames, plugins, workers, or media
 * - Pinned visualization CDNs allowed for scripts/styles/fonts (Chart.js, D3, ECharts, etc.)
 */
export const VISUAL_IFRAME_CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://d3js.org https://esm.sh",
	"style-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
	"img-src data: blob:",
	"font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
	"connect-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"media-src 'none'",
	"worker-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

/** Strict CSP for inert HTML code-fence previews (`sandbox=""`, zero script execution). */
export const INERT_HTML_PREVIEW_CSP = [
	"default-src 'none'",
	"style-src 'unsafe-inline'",
	"img-src data:",
	"font-src data:",
	"connect-src 'none'",
	"frame-src 'none'",
	"object-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
].join("; ");

export interface VisualThemeTokens {
	scheme: "dark" | "light";
	bg: string;
	surface1: string;
	surface2: string;
	elevated: string;
	codeBg: string;
	text: string;
	textSecondary: string;
	textMuted: string;
	textSubtle: string;
	border: string;
	borderSubtle: string;
	divider: string;
	accent: string;
	success: string;
	warning: string;
	danger: string;
	fontSans: string;
	fontMono: string;
	radiusSm: string;
	radiusMd: string;
	radiusLg: string;
}

export interface HeightGovernorDecision {
	height: number;
	frozen: boolean;
}

export interface VisualHeightGovernor {
	accept(rawHeight: number, now?: number): HeightGovernorDecision;
	reset(): void;
}

/** Clamp and govern iframe height reports to defeat `height: 100vh` feedback loops. */
export function createHeightGovernor(initialHeight = VISUAL_DEFAULT_HEIGHT): VisualHeightGovernor {
	let lastHeight = clampVisualHeight(initialHeight);
	let frozen = false;
	let consecutiveIncreases = 0;
	let increaseWindowStart = 0;
	let recentReports: number[] = [];

	return {
		accept(rawHeight: number, now = Date.now()): HeightGovernorDecision {
			if (frozen) return { height: lastHeight, frozen: true };
			if (!Number.isFinite(rawHeight) || rawHeight <= 0) return { height: lastHeight, frozen: false };

			recentReports = recentReports.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
			recentReports.push(now);
			if (recentReports.length > RATE_LIMIT_REPORTS) {
				frozen = true;
				return { height: lastHeight, frozen: true };
			}

			const clamped = clampVisualHeight(Math.ceil(rawHeight));
			if (clamped > lastHeight + 2) {
				if (consecutiveIncreases === 0 || now - increaseWindowStart > RUNAWAY_WINDOW_MS) {
					increaseWindowStart = now;
					consecutiveIncreases = 1;
				} else {
					consecutiveIncreases += 1;
				}
				if (consecutiveIncreases > RUNAWAY_INCREASE_LIMIT) {
					frozen = true;
					return { height: lastHeight, frozen: true };
				}
			} else if (clamped < lastHeight) {
				consecutiveIncreases = 0;
			}

			lastHeight = clamped;
			return { height: lastHeight, frozen: false };
		},
		reset() {
			lastHeight = clampVisualHeight(initialHeight);
			frozen = false;
			consecutiveIncreases = 0;
			increaseWindowStart = 0;
			recentReports = [];
		},
	};
}

export function clampVisualHeight(value: number): number {
	return Math.max(VISUAL_MIN_HEIGHT, Math.min(VISUAL_MAX_HEIGHT, Math.round(value)));
}

/** Generate a per-mount 128-bit random hex channel ID for parent↔iframe postMessage framing. */
export function generateVisualChannel(): string {
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		const bytes = new Uint8Array(16);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
	}
	return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, "0").slice(0, 32);
}

/** Sanitize a CSS value interpolated into the iframe's theme `<style>` block. */
function safeCssValue(value: string, fallback: string): string {
	const cleaned = value.replace(/[{}<>;]/g, "").trim();
	return cleaned || fallback;
}

/**
 * Build the theme stylesheet forwarded into the visual iframe. Exports both OMPdesk's
 * `--sc-*` design tokens and Orca's visual theme variables (`--background`, `--foreground`,
 * `--card`, `--muted`, `--border`, `--accent`, `--chart-1..5`, `--font-sans`, `--font-mono`)
 * so visuals authored for either OMPdesk or Orca render natively in Dark and Light themes.
 */
export function buildVisualThemeCss(tokens: VisualThemeTokens): string {
	const dark = tokens.scheme === "dark";
	const bg = safeCssValue(tokens.bg, dark ? "#141414" : "#ffffff");
	const surface1 = safeCssValue(tokens.surface1, dark ? "#1a1a1a" : "#fafafa");
	const surface2 = safeCssValue(tokens.surface2, dark ? "#222222" : "#f4f4f5");
	const elevated = safeCssValue(tokens.elevated, dark ? "#1c1c1c" : "#ffffff");
	const codeBg = safeCssValue(tokens.codeBg, dark ? "#181818" : "#f7f7f8");
	const text = safeCssValue(tokens.text, dark ? "#f2f2f2" : "#18181b");
	const textSecondary = safeCssValue(tokens.textSecondary, dark ? "#d4d4d8" : "#3f3f46");
	const textMuted = safeCssValue(tokens.textMuted, dark ? "#a1a1aa" : "#71717a");
	const textSubtle = safeCssValue(tokens.textSubtle, dark ? "#71717a" : "#a1a1aa");
	const border = safeCssValue(tokens.border, dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.12)");
	const borderSubtle = safeCssValue(tokens.borderSubtle, dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.08)");
	const divider = safeCssValue(tokens.divider, dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)");
	const accent = safeCssValue(tokens.accent, dark ? "#60a5fa" : "#2563eb");
	const success = safeCssValue(tokens.success, dark ? "#4ade80" : "#16a34a");
	const warning = safeCssValue(tokens.warning, dark ? "#fbbf24" : "#d97706");
	const danger = safeCssValue(tokens.danger, dark ? "#f87171" : "#dc2626");
	const fontSans = safeCssValue(tokens.fontSans, "system-ui, -apple-system, sans-serif");
	const fontMono = safeCssValue(tokens.fontMono, "ui-monospace, SFMono-Regular, monospace");
	const radiusSm = safeCssValue(tokens.radiusSm, "6px");
	const radiusMd = safeCssValue(tokens.radiusMd, "8px");
	const radiusLg = safeCssValue(tokens.radiusLg, "10px");

	const chart1 = accent;
	const chart2 = success;
	const chart3 = warning;
	const chart4 = dark ? "#c084fc" : "#7c3aed";
	const chart5 = danger;

	return [
		":root {",
		`  color-scheme: ${tokens.scheme};`,
		`  --sc-bg: ${bg};`,
		`  --sc-surface-1: ${surface1};`,
		`  --sc-surface-2: ${surface2};`,
		`  --sc-elevated: ${elevated};`,
		`  --sc-code-bg: ${codeBg};`,
		`  --sc-text: ${text};`,
		`  --sc-text-secondary: ${textSecondary};`,
		`  --sc-text-muted: ${textMuted};`,
		`  --sc-text-subtle: ${textSubtle};`,
		`  --sc-border: ${border};`,
		`  --sc-border-subtle: ${borderSubtle};`,
		`  --sc-divider: ${divider};`,
		`  --sc-accent: ${accent};`,
		`  --sc-success: ${success};`,
		`  --sc-warning: ${warning};`,
		`  --sc-danger: ${danger};`,
		`  --sc-font-sans: ${fontSans};`,
		`  --sc-font-mono: ${fontMono};`,
		`  --sc-radius-sm: ${radiusSm};`,
		`  --sc-radius-md: ${radiusMd};`,
		`  --sc-radius-lg: ${radiusLg};`,
		`  --background: ${surface1};`,
		`  --foreground: ${text};`,
		`  --card: ${elevated};`,
		`  --card-foreground: ${text};`,
		`  --muted: ${surface2};`,
		`  --muted-foreground: ${textMuted};`,
		`  --border: ${borderSubtle};`,
		`  --accent: ${surface2};`,
		`  --accent-foreground: ${text};`,
		`  --primary: ${accent};`,
		`  --destructive: ${danger};`,
		`  --chart-1: ${chart1};`,
		`  --chart-2: ${chart2};`,
		`  --chart-3: ${chart3};`,
		`  --chart-4: ${chart4};`,
		`  --chart-5: ${chart5};`,
		`  --font-sans: ${fontSans};`,
		`  --font-mono: ${fontMono};`,
		`  --radius: ${radiusMd};`,
		"}",
		"*, *::before, *::after { box-sizing: border-box; }",
		"html, body { margin: 0; padding: 0; background: transparent; color: var(--foreground); font-family: var(--font-sans); -webkit-font-smoothing: antialiased; }",
		"body { overflow-x: auto; }",
	].join("\n");
}

function buildBootstrapScript(channel: string): string {
	const safeChannel = JSON.stringify(channel);
	return [
		"(function(){",
		`  var CH = ${safeChannel};`,
		"  var lastH = 0;",
		"  function measure() {",
		"    var doc = document.documentElement;",
		"    var body = document.body;",
		"    var h = 0;",
		"    if (body) {",
		"      var rect = body.getBoundingClientRect();",
		"      h = Math.max(body.scrollHeight || 0, Math.ceil(rect.height || 0));",
		"    }",
		"    if (doc) h = Math.max(h, doc.scrollHeight || 0);",
		"    if (h > 0 && Math.abs(h - lastH) >= 1) {",
		"      lastH = h;",
		"      try { window.parent.postMessage({ type: 'omp-visual:resize', channel: CH, height: h }, '*'); } catch (_) {}",
		"    }",
		"  }",
		"  function schedule() { try { requestAnimationFrame(measure); } catch (_) { setTimeout(measure, 16); } }",
		"  window.addEventListener('message', function(ev) {",
		"    var d = ev && ev.data;",
		"    if (!d || d.channel !== CH) return;",
		"    if (d.type === 'omp-visual:theme' && typeof d.css === 'string') {",
		"      var el = document.getElementById('omp-visual-theme');",
		"      if (el) el.textContent = d.css;",
		"      schedule();",
		"    } else if (d.type === 'omp-visual:ping') {",
		"      try { window.parent.postMessage({ type: 'omp-visual:pong', channel: CH }, '*'); } catch (_) {}",
		"      schedule();",
		"    }",
		"  });",
		"  document.addEventListener('click', function(ev) {",
		"    var node = ev.target;",
		"    while (node && node.nodeType === 1 && node.tagName !== 'A') node = node.parentNode;",
		"    if (!node || node.tagName !== 'A') return;",
		"    var href = node.getAttribute('href') || '';",
		"    if (/^https?:\\/\\//i.test(href)) {",
		"      ev.preventDefault();",
		"      try { window.parent.postMessage({ type: 'omp-visual:open-link', channel: CH, href: href }, '*'); } catch (_) {}",
		"    }",
		"  }, true);",
		"  window.addEventListener('load', function() { schedule(); setTimeout(measure, 120); });",
		"  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(schedule); }",
		"  function observe() {",
		"    schedule();",
		"    if (typeof ResizeObserver === 'function' && document.body) {",
		"      try { new ResizeObserver(schedule).observe(document.body); } catch (_) {}",
		"    }",
		"    if (typeof MutationObserver === 'function' && document.body) {",
		"      try { new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true }); } catch (_) {}",
		"    }",
		"  }",
		"  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', observe); } else { observe(); }",
		"})();",
	].join("\n");
}

function stripDangerousHeadTags(html: string): string {
	return html
		.replace(/<base\b[^>]*>/gi, "")
		.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*(?:refresh|content-security-policy)\b[^>]*>/gi, "");
}

function injectIntoHtml(html: string, injection: string): string {
	const cleaned = stripDangerousHeadTags(html);
	if (/<head\b[^>]*>/i.test(cleaned)) {
		return cleaned.replace(/<head\b[^>]*>/i, match => `${match}\n${injection}\n`);
	}
	if (/<html\b[^>]*>/i.test(cleaned)) {
		return cleaned.replace(/<html\b[^>]*>/i, match => `${match}\n<head>\n${injection}\n</head>\n`);
	}
	return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${injection}\n</head>\n<body>\n${cleaned}\n</body>\n</html>`;
}

/** Build the complete `srcDoc` payload for a live sandboxed HTML visual iframe. */
export function buildSandboxedVisualSrcDoc({
	html,
	channel,
	themeCss,
}: {
	html: string;
	channel: string;
	themeCss: string;
}): string {
	const escapedTheme = themeCss.replace(/<\/style/gi, "<\\/style");
	const injection = [
		'<base href="about:srcdoc">',
		`<meta http-equiv="Content-Security-Policy" content="${VISUAL_IFRAME_CSP}">`,
		`<style id="omp-visual-theme">${escapedTheme}</style>`,
		`<script>${buildBootstrapScript(channel)}</script>`,
	].join("\n");
	return injectIntoHtml(html, injection);
}

/** Whether a fenced `html` code block looks like a complete renderable HTML document (Wave A3). */
export function isHtmlDocumentCodeBlock(code: string): boolean {
	const trimmed = code.trim();
	if (trimmed.length < 16) return false;
	return /^<!doctype\s+html\b/i.test(trimmed) || /^<html\b/i.test(trimmed);
}

/** Build a strictly inert (`sandbox=""`) `srcDoc` for previewing HTML code blocks without scripts. */
export function buildInertHtmlPreviewSrcDoc(html: string, themeCss: string): string {
	const withoutScripts = stripDangerousHeadTags(html).replace(/<script\b[\s\S]*?<\/script>/gi, "");
	const escapedTheme = themeCss.replace(/<\/style/gi, "<\\/style");
	const injection = [
		'<base href="about:srcdoc">',
		`<meta http-equiv="Content-Security-Policy" content="${INERT_HTML_PREVIEW_CSP}">`,
		`<style id="omp-visual-theme">${escapedTheme}</style>`,
	].join("\n");
	return injectIntoHtml(withoutScripts, injection);
}
