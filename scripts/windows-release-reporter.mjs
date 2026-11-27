import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = [
	"e2e/bot-rename.e2e.ts › a bot renamed before its first chat updates its soul and signs a message on reopen",
	"e2e/bots-remote.e2e.ts › a paired bot chat reopens its delegated worker in another repository without taking the human sibling",
];

// Selected as N/A before execution. The existing Windows guard must still produce this exact skip, never a pass.
export const windowsNotApplicable = new Map([
	[
		"e2e/packaged-ai-memory.e2e.ts › @smoke macOS: the packaged app's first launch stages the shipped ai-memory, gets ready and creates its extension root",
		"the macOS package and its launchd service",
	],
	[
		"e2e/terminal.e2e.ts › @smoke real interactive terminal in light",
		"no installed stock omp natives on the Windows e2e runner",
	],
	[
		"e2e/web-tabs-relaunch.e2e.ts › @smoke A paired phone's tab comes back after the computer restarts (quit): one tab, the same session, no copy on the desktop",
		"the fake Tailscale is a shebang script run by bun",
	],
]);

export default class WindowsReleaseReporter {
	cases = [];

	onBegin(_config, suite) {
		this.cases = suite.allTests().map(test => {
			const name = `${relative(root, test.location.file).split(sep).join("/")} › ${test.title}`;
			return { test, name, na: windowsNotApplicable.get(name) };
		});
	}

	onEnd(result) {
		const run = `run ${process.env.GITHUB_RUN_ID ?? "local"}, attempt ${process.env.GITHUB_RUN_ATTEMPT ?? 1}`;
		let held = false;
		const fail = message => {
			held = true;
			const escaped = stripVTControlCharacters(message)
				.replaceAll("%", "%25")
				.replaceAll("\r", "%0D")
				.replaceAll("\n", "%0A");
			console.log(`::error title=Required Windows app set::${run}: ${escaped}`);
		};
		const missing = new Set([...required, ...windowsNotApplicable.keys()]);
		let passed = 0;
		let notApplicable = 0;
		for (const { test, name, na } of this.cases) {
			missing.delete(name);
			const attempts = test.results;
			const statuses = attempts.map(attempt => attempt.status).join(", ") || "not run";
			const skip = test.annotations.find(annotation => annotation.type === "skip" || annotation.type === "fixme");
			if (
				na &&
				test.expectedStatus === "skipped" &&
				attempts.length === 1 &&
				statuses === "skipped" &&
				skip?.type === "skip" &&
				skip.description === na
			) {
				console.log(`N/A on Windows: ${name}: ${na}`);
				notApplicable++;
			} else if (
				!na &&
				test.expectedStatus === "passed" &&
				attempts.length &&
				attempts.every(attempt => attempt.status === "passed")
			) {
				passed++;
			} else {
				const detail = attempts.find(attempt => attempt.error)?.error.message ?? skip?.description;
				fail(
					`${name}: ${na ? `expected Windows N/A (${na})` : "required a pass"}; expectedStatus=${test.expectedStatus}, actual=${statuses}${detail ? `: ${detail}` : ""}`,
				);
			}
		}
		for (const name of missing) fail(`${name}: missing from Playwright discovery`);
		if (!held && result.status !== "passed") fail(`Playwright run ${result.status}`);
		console.log(
			`Required Windows app set (${run}): ${passed} passed, ${notApplicable} N/A, ${this.cases.length} discovered; Playwright wall time ${result.duration} ms; runner ${result.status}.`,
		);
		return { status: held && result.status === "passed" ? "failed" : result.status };
	}
}
