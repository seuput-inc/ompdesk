"use strict";
// ompdesk check: one JSON line per finished test attempt into $OMPDESK_CHECK_RESULTS, written as each test ends, so a
// run cut off half way still says what passed. Playwright adds it beside the project's own reporters
// (PW_TEST_REPORTER), so it records a run started deep inside a script too. The last line of a test wins: a failed
// attempt that is retried and passes ends as "flaky".
const fs = require("node:fs");
const path = require("node:path");

const OUTCOME = { expected: "passed", unexpected: "failed", flaky: "flaky", skipped: "skipped" };
// Assertions can print credentials, selectors, and page text. Keep the category and source coordinates instead.
function firstError(error, location) {
	if (!error) return undefined;
	const message = String(error.message ?? error.value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
	const matcher = /\bexpect\([^\n)]*\)\.(?:not\.)?(toBe|toEqual|toHaveText|toContainText|toBeVisible|toHaveCount|toHaveURL|toBeEnabled|toMatch)\(/.exec(message)?.[1];
	let kind = "Playwright error";
	if (matcher) kind = `expect(...).${matcher} assertion failed`;
	else if (message.includes("expect(") || message.includes("AssertionError")) kind = "expect(...) assertion failed";
	else if (/TimeoutError|timed out|timeout .* exceeded/i.test(message)) kind = "Playwright timeout";
	if (Number.isSafeInteger(location?.line) && Number.isSafeInteger(location?.column)) {
		return `${kind} at line ${location.line}:${location.column}`;
	}
	return kind;
}

class OmpdeskCheckReporter {
	constructor() {
		this.out = process.env.OMPDESK_CHECK_RESULTS;
		this.root = process.cwd();
		this.config = "";
	}
	printsToStdio() {
		return false;
	}
	onBegin(config, suite) {
		this.suite = suite;
		this.root = config.rootDir;
		this.config = config.configFile || "";
	}
	write(record) {
		if (!this.out) return;
		try {
			fs.appendFileSync(this.out, `${JSON.stringify(record)}\n`);
		} catch {}
	}
	onTestEnd(test, result) {
		const outcome = test.outcome();
		const status = outcome === "skipped" && result.status === "interrupted" ? "interrupted"
			: outcome === "skipped" && test.expectedStatus !== "skipped" ? "unrun"
			: OUTCOME[outcome] || "failed";
		this.record(test, status, result);
	}
	record(test, status, result) {
		// A reporter's titlePath() starts with the root suite's empty title, then the project, the file and the titles;
		// --test-list names project, file and titles (its own split runs on the path without the root).
		const [, project, , ...titles] = test.titlePath();
		const file = path.relative(this.root, test.location.file).split(path.sep).join("/");
		const error = result?.error ?? result?.errors?.[0];
		this.write({
			runner: "playwright",
			config: this.config,
			project,
			file,
			abs: test.location.file,
			titles,
			status,
			ms: result?.duration ?? 0,
			error: firstError(error, error?.location?.file === test.location.file ? error.location : test.location),
		});
	}
	onError(error) {
		// An error outside any test (global setup, a worker that crashed): no test result says it.
		this.runnerErrors = (this.runnerErrors ?? 0) + 1;
		this.write({
			runner: "playwright", config: this.config, kind: "error", status: "failed",
			titles: [`Playwright runner error ${this.runnerErrors}`], error: firstError(error, error?.location),
		});
	}
	onEnd(result) {
		for (const test of this.suite?.allTests() ?? []) {
			if (!test.results.length) this.record(test, "unrun");
		}
		this.write({ runner: "playwright", config: this.config, end: result.status });
	}
}

module.exports = OmpdeskCheckReporter;
