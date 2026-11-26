/** `ompdesk_schedule` in the transcript: one line per action, a webhook card without its key, the rest generic. */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { getToolRenderer } from "../index";
import { GenericRenderer } from "./GenericRenderer";
import { ScheduleRenderer } from "./ScheduleRenderer";

const KEY = "Zk3v9QmW2xYpL8rT0aBcDeFgHiJk";
const WEBHOOK_ANSWER = `Scheduled “[agent] Deploy hook” on a webhook call in /work/app on this computer; id s7; waits for its event. It runs only while OMPdesk is open on this computer, never with auto-approve; cancel it with ompdesk_schedule {"action":"cancel","id":"s7"}. Webhook: POST /hooks/s7 on that computer's OMPdesk web server (on while Mobile web is on: http://127.0.0.1:<its port> there, or its Mobile web link from the tailnet) with the header "Authorization: Bearer ${KEY}"; the request body is passed to the run.`;

function render(args: Record<string, unknown>, text = "", isError = false): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<ScheduleRenderer args={args} isError={isError} result={{ content: [{ type: "text", text }] }} />
		</I18nProvider>,
	);
}

describe("ScheduleRenderer", () => {
	it("is the renderer of ompdesk_schedule", () => {
		expect(getToolRenderer("ompdesk_schedule")).not.toBe(GenericRenderer);
	});

	it("says a saved schedule's name and when it runs", () => {
		const daily = render({ action: "create", name: "Tidy", prompt: "Tidy up", daily_at: "09:30", days: [1, 3] });
		expect(daily).toContain("Schedule saved: Tidy · ");
		expect(daily).toContain("at 09:30");
		expect(render({ action: "update", name: "Tidy", every_minutes: 120 })).toContain(
			"Schedule saved: Tidy · Every 2 h",
		);
		expect(
			render({ action: "create", name: "PRs", on: { source: "github", repo: "octo/app", events: ["pr_merged"] } }),
		).toContain("GitHub merged pull requests in octo/app");
		expect(render({ action: "create", name: "Later", in_minutes: 15 })).toContain("In 15 min");
	});

	it("shows a webhook routine's path and never its key", () => {
		const markup = render({ action: "create", name: "Deploy hook", on: { source: "webhook" } }, WEBHOOK_ANSWER);
		expect(markup).toContain("On a webhook call");
		expect(markup).toContain("data-tool-schedule-webhook");
		expect(markup).toContain("/hooks/s7");
		expect(markup).toContain('aria-label="Copy URL"');
		expect(markup).not.toContain(KEY);
	});

	it("reads a run and a cancel as one line, and leaves other actions and failures generic", () => {
		expect(render({ action: "run", id: "s7" })).toContain("Run started");
		expect(render({ action: "cancel", id: "s7" })).toContain("Schedule cancelled");
		expect(render({ action: "list" }, "No schedules.")).not.toContain("data-tool-schedule");
		expect(render({ action: "create", name: "Bad" }, "create needs exactly one start", true)).not.toContain(
			"Schedule saved",
		);
	});
});
