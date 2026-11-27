import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import WindowsReleaseReporter, { windowsNotApplicable } from "./windows-release-reporter.mjs";

const rename =
	"e2e/bot-rename.e2e.ts › a bot renamed before its first chat updates its soul and signs a message on reopen";
const worker =
	"e2e/bots-remote.e2e.ts › a paired bot chat reopens its delegated worker in another repository without taking the human sibling";
const smoke = "e2e/feature.e2e.ts › @smoke another selected test";

function selected(name, statuses = ["passed"], expectedStatus = "passed", annotations = []) {
	const [file, title] = name.split(" › ");
	return {
		location: { file: fileURLToPath(new URL(`../${file}`, import.meta.url)) },
		title,
		expectedStatus,
		annotations,
		results: statuses.map(status => ({ status })),
	};
}

const exceptions = () =>
	Array.from(windowsNotApplicable, ([name, description]) =>
		selected(name, ["skipped"], "skipped", [{ type: "skip", description }]),
	);

function report(tests, status = "passed") {
	vi.stubEnv("GITHUB_RUN_ID", "4567");
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	log.mockClear();
	const reporter = new WindowsReleaseReporter();
	reporter.onBegin({}, { allTests: () => tests });
	const verdict = reporter.onEnd({ status, duration: 1234 });
	return { status: verdict.status, output: log.mock.calls.map(([line]) => line).join("\n") };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

test("reports actual passes, Windows N/A and runner wall time separately", () => {
	const receipt = report([selected(rename), selected(worker), selected(smoke), ...exceptions()]);
	expect(receipt.status).toBe("passed");
	expect(receipt.output).toContain("3 passed, 3 N/A, 6 discovered");
	expect(receipt.output).toContain("1234 ms");
	for (const [name, reason] of windowsNotApplicable)
		expect(receipt.output).toContain(`N/A on Windows: ${name}: ${reason}`);
	expect(receipt.output).not.toContain("::error");
});

test("holds discovery missing either bot case, even with another case from the same file", () => {
	for (const [missing, present] of [
		[rename, worker],
		[worker, rename],
	]) {
		const { status, output } = report([selected(present), selected(`${missing} (another case)`), ...exceptions()]);
		expect(status).toBe("failed");
		expect(output).toContain(`${missing}: missing from Playwright discovery`);
	}
});

test.each([
	[[], "passed", "not run"],
	[["skipped"], "skipped", "skipped"],
	[["interrupted"], "passed", "interrupted"],
	[["timedOut"], "passed", "timedOut"],
	[["failed"], "failed", "failed"],
	[["passed"], "failed", "passed"],
	[["failed", "passed"], "passed", "failed, passed"],
])("holds a selected test with attempts %j and expected status %s", (attempts, expected, actual) => {
	const { status, output } = report([
		selected(rename),
		selected(worker),
		selected(smoke, attempts, expected),
		...exceptions(),
	]);
	expect(status).toBe("failed");
	expect(output).toContain("::error title=Required Windows app set::run 4567");
	expect(output).toContain(`${smoke}: required a pass; expectedStatus=${expected}, actual=${actual}`);
});

test("holds a stale exception whether it passed, vanished or skipped for a new reason", () => {
	const [name] = windowsNotApplicable.keys();
	const tests = [selected(rename), selected(worker), ...exceptions().slice(1)];
	for (const receipt of [
		report(tests),
		report([...tests, selected(name)]),
		report([...tests, selected(name, ["skipped"], "skipped", [{ type: "skip", description: "different reason" }])]),
	]) {
		expect(receipt.status).toBe("failed");
		expect(receipt.output).toContain(name);
		expect(receipt.output).toContain("::error title=Required Windows app set::");
	}
});

test("escapes failure details into one annotation per test without masking Playwright's verdict", () => {
	const broken = selected(smoke, ["failed"]);
	broken.results[0].error = { message: "47%\r\n::warning::second line" };
	const tests = [selected(rename), selected(worker), broken, ...exceptions()];
	const { status, output } = report(tests, "interrupted");
	expect(status).toBe("interrupted");
	expect(output.match(/::error title=Required Windows app set::/g)).toHaveLength(1);
	expect(output).toContain("47%25%0D%0A::warning::second line");
	expect(report([selected(rename), selected(worker), ...exceptions()], "failed").status).toBe("failed");
});
