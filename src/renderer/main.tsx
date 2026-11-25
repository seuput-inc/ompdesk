import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import type { ShellStreamReset } from "../preload/shell";
import { App } from "./App";
import { RootErrorBoundary } from "./components/common/RootErrorBoundary";
import { loadSidebar, sessionListBeforeFirstRender } from "./components/layout/sidebar-chunk";
import { installTranscriptSeeding } from "./hooks/session-hydration";
import { lazyChunk, watchChunkFailures } from "./lib/chunk-load";
import { getCurrentLanguage, I18nProvider, loadLocale } from "./lib/i18n";
import { loadMotionPlay } from "./lib/motion";
import { installGlobalRuntimeErrorHandlers, reportRuntimeError } from "./lib/runtime-errors";
import "./styles/global.css";
import "./styles/tokens.css";
import "./styles/theme-dark.css";
import "./styles/theme-light.css";
import "./styles/components.css";
import "./styles/work-board.css";
import "./styles/subagent-view.css";
import "./styles/usage-gauges.css";
import "./styles/mobile.css";

/** Internal design review page: OMP_GUI_STYLEGUIDE=1 opens the window at this hash. */
const StyleGuide = lazyChunk(() => import("./components/styleguide/StyleGuide"));

installGlobalRuntimeErrorHandlers();
watchChunkFailures();
const shellStream = (window as Window & { __ompShellStream?: ShellStreamReset }).__ompShellStream;
if (shellStream) {
	let installing = false;
	const wake = () => {
		if (installing || !shellStream.pending()) return;
		window.removeEventListener("online", wake);
		document.removeEventListener("visibilitychange", visible);
		installing = true;
		// Recovery is loaded only after a stream gap, outside the first-screen bundle.
		void import("./web/resync")
			.then(({ installShellResync }) =>
				installShellResync(
					shellStream,
					async () => (await import("./web/resync-page")).resyncPage({ strict: true }),
					failures =>
						reportRuntimeError("background-task", new Error("Shell resync failed"), { details: { failures } }),
				),
			)
			.catch(error => {
				installing = false;
				reportRuntimeError("background-task", error, { details: { task: "shell-resync" } });
				window.addEventListener("online", wake);
				document.addEventListener("visibilitychange", visible);
			});
	};
	const visible = () => {
		if (document.visibilityState === "visible") wake();
	};
	shellStream.onReset(wake);
}
// A tab's last known transcript page paints as soon as the tab is known (lib/transcript-snapshot.ts): the tabs of
// the last run (lib/tab-snapshot.ts) are in the store before the first render, so their rows are too.
installTranscriptSeeding();
// Looping cues step at ten frames a second while the window is on screen but not focused (lib/cue-clock.ts); loaded
// after the first screen, which it never changes.
void import("./lib/cue-clock").then(({ installCueClock }) => installCueClock());
// A modifier pressed alone after a click never rings what the click focused (lib/focus-modality.ts); loaded after the
// first screen, which it never changes.
void import("./lib/focus-modality").then(({ installFocusModality }) => installFocusModality());
// What moves a list, a disclosure's height or a leaving overlay (lib/motion-play.ts); loaded after the first screen,
// where nothing moves before a person acts.
void loadMotionPlay();

const container = document.getElementById("root");
if (!container) {
	const error = new Error("Root container #root not found");
	reportRuntimeError("react-uncaught", error, { url: window.location.href });
	throw error;
}

const root = createRoot(container, {
	onCaughtError: (error, info) => {
		reportRuntimeError("react-render", error, { componentStack: info.componentStack });
	},
	onUncaughtError: (error, info) => {
		reportRuntimeError("react-uncaught", error, { componentStack: info.componentStack });
	},
	onRecoverableError: (error, info) => {
		reportRuntimeError("react-recoverable", error, { componentStack: info.componentStack });
	},
});

// The UI's strings are a chunk per language (lib/i18n.tsx): the first render waits for the current one, so no
// text ever paints as its key; a chunk that fails to load still renders (English keys) rather than nothing. The
// session list's chunk joins it where the list is in the first frame or the next touch must not wait on the network
// (components/layout/sidebar-chunk.ts).
const render = () =>
	root.render(
		<RootErrorBoundary>
			<I18nProvider>
				{window.location.hash === "#/styleguide" ? (
					<Suspense fallback={null}>
						<StyleGuide />
					</Suspense>
				) : (
					<App />
				)}
			</I18nProvider>
		</RootErrorBoundary>,
	);
void Promise.all([loadLocale(getCurrentLanguage()), sessionListBeforeFirstRender() ? loadSidebar() : null]).then(
	render,
	render,
);
