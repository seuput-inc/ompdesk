import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";

// What a person types in the composer and answers on the Plan card, through the built app on the real system omp: an
// isolated agent dir whose only model is a scripted provider on loopback (no credentials, no spend). `!` runs a shell
// line whose output joins the model's context, `!!` one whose output stays out of it, and the Plan card's "Approve and
// execute" ends plan mode and runs stock's approved-plan prompt. The bridge methods under these (`composer.*`,
// `modes.plan_approval`) are pinned on stock omp by bridge-composer-stock.test.ts and bridge-auto-plan-stock.test.ts,
// the card's rendering by PlanApprovalDialog.test.tsx; this spec covers the path from the window to stock and back.

const PLAN = "# Greeting\n\n1. Add the greeting file.\n2. Run the checks.\n";
const PLAN_MARK = "PLAN-MARK add a greeting file";

/** One OpenAI-style streamed reply. */
function sse(delta: unknown, finish: string): string {
	const frame = (value: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame(delta)}${frame({}, finish)}data: [DONE]\n\n`;
}

function writeCall(target: string, content: string): string {
	const call = { index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function" };
	return sse(
		{ tool_calls: [{ ...call, function: { name: "write", arguments: JSON.stringify({ path: target, content }) } }] },
		"tool_calls",
	);
}

/** The text of every message a model request carried. */
function messagesOf(body: string): string {
	const parsed: { messages?: Array<{ content?: unknown }> } = JSON.parse(body);
	return (parsed.messages ?? []).map(message => JSON.stringify(message.content ?? "")).join("\n");
}

test("the composer's ! and !! lines and the Plan card, on the real omp", async () => {
	test.setTimeout(240_000);
	const bodies: string[] = [];
	let planSteps = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			res.writeHead(200, { "content-type": "text/event-stream" });
			// Side requests (a title, a suggestion) carry no write tool.
			if (!(parsed.tools ?? []).some(tool => tool.function?.name === "write")) {
				res.end(sse({ content: "side" }, "stop"));
				return;
			}
			bodies.push(body);
			const text = messagesOf(body);
			if (text.includes(PLAN_MARK) && !text.includes("Plan approved.") && planSteps < 2) {
				planSteps++;
				res.end(
					planSteps === 1 ? writeCall("local://greeting-plan.md", PLAN) : writeCall("xd://propose", "greeting"),
				);
				return;
			}
			res.end(sse({ content: "DONE" }, "stop"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-real-composer-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	await fs.writeFile(
		path.join(agent, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	await fs.writeFile(path.join(agent, "config.yml"), "modelRoles:\n  default: fake/m1\n");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
		}),
	);
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "OMP_GUI_OMP", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"])
		Reflect.deleteProperty(env, key);
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	try {
		const page = await app.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 90_000 })
			.toMatchObject({ status: "ready" });
		const composer = page.locator("textarea").first();
		const transcript = page.locator("[data-transcript-kind]");
		const send = async (text: string) => {
			await composer.fill(text);
			await composer.press("Enter");
		};

		// `!`: the output shows in the transcript and the next model request carries it.
		await send("!printf 'shell%s' -in-context");
		await expect(transcript.filter({ hasText: "shell-in-context" }).first()).toBeVisible({ timeout: 30_000 });
		// `!!`: the output shows, but no model request carries it.
		await send("!!printf 'shell%s' -kept-out");
		await expect(transcript.filter({ hasText: "shell-kept-out" }).first()).toBeVisible({ timeout: 30_000 });
		await send("say done");
		await expect.poll(() => bodies.length, { timeout: 60_000 }).toBeGreaterThan(0);
		const first = messagesOf(bodies[0] ?? "");
		expect(first).toContain("shell-in-context");
		expect(first).not.toContain("shell-kept-out");

		// The Plan card: the user's plan mode, a proposal, "Approve and execute".
		await page.evaluate(async () => {
			const result = await window.omp.rpc.setPlanMode(true);
			if (!result.success) throw new Error(result.error);
		});
		await send(PLAN_MARK);
		const approve = page.locator("[data-choice]").filter({ hasText: "Approve and execute" });
		await expect(approve).toBeVisible({ timeout: 60_000 });
		await expect(page.locator("[data-plan-content]")).toContainText("Add the greeting file.");
		await approve.click();
		await expect(approve).toHaveCount(0);
		await expect
			.poll(() => bodies.some(body => messagesOf(body).includes("Plan approved.")), { timeout: 60_000 })
			.toBe(true);
		const approved = bodies.find(body => messagesOf(body).includes("Plan approved.")) ?? "";
		expect(messagesOf(approved)).toContain("Add the greeting file.");
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getState().then(state => state.success && state.data)))
			.toMatchObject({ planModeEnabled: false });
	} finally {
		await exitApp(app);
		server.closeAllConnections();
		await new Promise<void>(done => server.close(() => done()));
		await fs.rm(profile, { recursive: true, force: true });
	}
});
