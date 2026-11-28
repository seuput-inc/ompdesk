// A write under the real ~/.omp, ~/.pi, ~/.config/omp or OMPdesk's userData fails the test.
import "./scripts/vitest-real-home-guard";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect } from "vitest";
import { watchBlockedThread, watchedTest } from "./scripts/vitest-block-watch";
import { exitWhenParentGone } from "./scripts/vitest-orphan-guard";
import { SESSION_OWNED_ENV } from "./src/main/omp-launch";
import { loadLocale } from "./src/renderer/lib/i18n";
import { dropGitSelectors } from "./src/shared/git-env";

// Each worker too: a leaked GIT_DIR or its kin would send a test's temp-repo git to another repository
// (src/shared/git-env.ts).
dropGitSelectors();

// Fixture checkouts must not contend with the real check that already owns this test worker's slot.
process.env.OMPDESK_HEAVY_DIR = join(
	tmpdir(),
	`worktree-test-pool-${process.pid}-${process.env.VITEST_WORKER_ID ?? 0}`,
);

// Nor the plumbing of the OMPdesk session a run is launched from (its bridge socket, computer-use engine, memory file,
// ...): a stock test's omp inherits `process.env`, and one left on that session's agent-desktop engine without the
// MCP server waited 10 s for it at its first prompt and built a different system prompt (src/main/omp-launch.ts).
for (const key of SESSION_OWNED_ENV) delete process.env[key];

// omp's service broker (a `wait` starts it, and on Windows the bridge before a session's first bash) inherits the
// session's folder as its working folder and stays 3 s after its last omp leaves (stock launch/broker.ts
// DEFAULT_IDLE_GRACE_MS); on Windows a stock test's cleanup then cannot remove that folder (EBUSY). The broker inherits
// omp's environment, and with no grace it ends as soon as the test's omp does.
process.env.OMP_DAEMON_IDLE_GRACE_MS = "0";

// A worker whose run was killed ends itself instead of running on as an orphan (scripts/vitest-orphan-guard.ts).
exitWhenParentGone();

// A test thread a synchronous call never gives back names its test and step and ends, instead of holding the run until
// the CI job's limit (scripts/vitest-block-watch.ts).
watchBlockedThread();
beforeEach(() => {
	const { testPath, currentTestName } = expect.getState();
	watchedTest(`${testPath ?? "?"} > ${currentTestName ?? "?"}`);
});

if (typeof navigator !== "undefined") {
	Object.defineProperty(navigator, "language", { configurable: true, get: () => "en-US" });
	// Keymap defaults and shortcut labels follow navigator.platform; pin macOS so
	// the suite behaves the same on the Windows CI runner.
	Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" });
}

// The UI's strings are a chunk per language (src/renderer/lib/i18n.tsx); the entries load the current one before
// they render, and the tests have both from the start.
await Promise.all([loadLocale("en"), loadLocale("ko")]);
