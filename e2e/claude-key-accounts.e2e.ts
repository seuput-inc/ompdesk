/** Real key management and session selection against a strictly local, key-specific Claude API. */
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import type { RpcSessionState } from "../src/shared/rpc-types";
import { appLaunchOptions, exitApp, pressShortcutUntilVisible } from "./harness";

const keys = ["offline-probe-key-a", "offline-probe-key-b"];
const shared = "probe-shared";
const offered = [
	[shared, "probe-only-a"],
	[shared, "probe-only-b"],
];

async function profile(real: boolean) {
	// Run stock only on the hosted Windows runner, never on a developer's machine or with their credentials.
	expect(process.env.RUNNER_ENVIRONMENT).toBe("github-hosted");
	const root = await mkdtemp(join(tmpdir(), "omp-key-accounts-"));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => join(root, name));
	await Promise.all([project, desktop, agent].map(dir => mkdir(dir)));
	await writeFile(
		join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			accountRotation: "even",
			lastProject: project,
			autoTitle: false,
			nextPromptSuggestions: false,
			nextPromptInline: false,
			judgeAssist: false,
		}),
	);
	const options = await appLaunchOptions({
		project,
		desktop,
		agent,
		profile: root,
		env: real
			? { OMP_GUI_OMP: undefined }
			: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_TEST_SIGNED_OUT: "1" },
	});
	for (const name of Object.keys(options.env)) {
		if (/KEY|TOKEN|SECRET|PASSWORD|^ANTHROPIC_|^CLAUDE_/i.test(name)) delete options.env[name];
	}
	return { options, agent, project };
}

async function ready(page: Page) {
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 90_000 })
		.toMatchObject({ status: "ready" });
}

async function provider() {
	const lists: number[] = [];
	const posts: number[] = [];
	const guards = new Set<string>();
	const turns: { prompt: string; account: number }[] = [];
	const server = createServer(async (req, res) => {
		if (req.method === "GET" && /^\/guard\/\d+$/.test(req.url ?? "")) {
			guards.add(String(req.url));
			res.writeHead(204).end();
			return;
		}
		const account = keys.indexOf(String(req.headers["x-api-key"] ?? ""));
		if (req.method === "POST") posts.push(account);
		if (account < 0) {
			res.writeHead(401).end();
			return;
		}
		if (req.method === "GET" && req.url?.split("?")[0] === "/v1/models") {
			lists.push(account);
			res.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					data: offered[account].map(id => ({ id, type: "model", display_name: id })),
					has_more: false,
				}),
			);
			return;
		}
		if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of req) body += chunk;
		const prompt = /test-key-turn-[12]/.exec(body)?.[0];
		if (prompt) turns.push({ prompt, account });
		res.writeHead(200, { "content-type": "text/event-stream" });
		const event = (type: string, data: object) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		event("message_start", {
			message: {
				id: "msg_probe",
				type: "message",
				role: "assistant",
				model: shared,
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		});
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		event("content_block_delta", {
			index: 0,
			delta: { type: "text_delta", text: `Local answer ${prompt?.at(-1) ?? ""}` },
		});
		event("content_block_stop", { index: 0 });
		event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
		event("message_stop", {});
		res.end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("missing loopback port");
	return { origin: `http://127.0.0.1:${address.port}`, guards, lists, posts, turns, close: () => server.close() };
}

async function guardProvider(project: string, env: NodeJS.ProcessEnv, origin: string) {
	// Redirect only after stock chooses headers for the official host. Never contact the provider.
	const preload = join(project, "guard.cjs");
	await writeFile(join(project, "bunfig.toml"), 'preload = ["./guard.cjs"]\n');
	await writeFile(
		preload,
		`
if (!globalThis.__keyFixtureGuard) {
globalThis.__keyFixtureGuard = true;
const origin = ${JSON.stringify(origin)}, allowed = ${JSON.stringify(keys)};
for (const [module, method] of [["node:https", "get"], ["node:https", "request"], ["node:tls", "connect"]]) {
	require(module)[method] = () => { throw new Error("external TLS blocked by the Claude account fixture"); };
}
const send = globalThis.fetch;
globalThis.fetch = Object.assign(async (input, init) => {
	const request = new Request(input, init), url = new URL(request.url);
	if (url.origin === origin) return send(input, { ...init, redirect: "error" });
	if (url.origin !== "https://api.anthropic.com" ||
		!((request.method === "GET" && url.pathname === "/v1/models") ||
		  (request.method === "POST" && url.pathname === "/v1/messages"))) {
		throw new Error("external request blocked by the Claude account fixture");
	}
	if (!allowed.includes(request.headers.get("x-api-key"))) {
		throw new Error("expected a dummy fixture key in x-api-key");
	}
	return send(origin + url.pathname + url.search, {
		method: request.method, headers: request.headers,
		body: request.method === "POST" ? await request.arrayBuffer() : undefined,
		signal: request.signal, redirect: "error",
	});
}, { preconnect() {} });
if (process.argv.includes("rpc-ui")) void send(origin + "/guard/" + process.pid);
}
`,
	);
	env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
	env.PI_REQUEST_COMPRESSION = "0";
}

test("two Claude keys share the subscription heading, list their own models and show the billing fallback", async () => {
	test.setTimeout(150_000);
	const { options, project } = await profile(false);
	const fake = await provider();
	await guardProvider(project, options.env, fake.origin);
	const app = await electron.launch(options);
	try {
		expect(await app.evaluate(() => Reflect.get(globalThis, "__keyFixtureGuard"))).toBe(true);
		await app.evaluate(({ shell }) => {
			shell.openExternal = async url => {
				Reflect.set(globalThis, "probeOpenedBilling", url);
			};
		});
		const page = await app.firstWindow();
		await ready(page);
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="models"]').click();
		for (const key of keys) {
			await settings.locator('[data-provider-add="anthropic"]').click();
			await page
				.locator("[data-claude-connect]")
				.getByRole("button", { name: en["providers.featured.apiKey"] })
				.click();
			const form = page.locator("[data-claude-key]");
			await form.locator('input[type="password"]').fill(key);
			await form.locator('button[type="submit"]').click();
			await expect(form).toBeHidden();
		}
		const list = settings.locator("[data-provider-list]");
		await expect(list.getByText(en["providers.apiBalanceUnknown"]).first()).toBeVisible();
		await list.getByRole("button", { name: en["providers.consoleBilling"] }).first().click();
		await expect
			.poll(() => app.evaluate(() => Reflect.get(globalThis, "probeOpenedBilling")))
			.toBe("https://platform.claude.com/settings/billing");
		await list.screenshot({ path: test.info().outputPath("connected.png") });
		const headings = await list
			.locator(':scope > [data-provider-row^="anthropic"]')
			.evaluateAll(rows => rows.map(row => row.getAttribute("data-provider-row")));
		const models = await page.evaluate(async () =>
			(await window.omp.models.listProviders()).providers
				.filter(p => p.id.startsWith("anthropic-api-key"))
				.map(p => p.models.map(m => m.id)),
		);
		console.log("#42 settings", { headings, models, lookups: fake.lists, balanceUnknown: true, billingButton: true });
		expect.soft(headings, "One provider heading").toEqual(["anthropic"]);
		expect.soft(models, "Offered model IDs for each key").toEqual(offered);
		expect.soft(new Set(fake.lists), "Both keys queried").toEqual(new Set([0, 1]));
	} finally {
		await exitApp(app);
		fake.close();
	}
});

test("new auto picks on a shared model pin different keys and show the key that actually answered", async () => {
	test.setTimeout(240_000);
	const { options, agent, project } = await profile(true);
	const fake = await provider();
	await guardProvider(project, options.env, fake.origin);
	await writeFile(
		join(agent, "models.yml"),
		JSON.stringify({
			providers: Object.fromEntries(
				keys.map((key, i) => [
					i === 0 ? "anthropic-api-key" : "anthropic-api-key-2",
					{
						baseUrl: "https://api.anthropic.com",
						auth: "apiKey",
						api: "anthropic-messages",
						apiKey: key,
						models: offered[i].map(id => ({ id, name: id, reasoning: false })),
					},
				]),
			),
		}),
	);
	await writeFile(join(agent, "config.yml"), JSON.stringify({ modelRoles: { default: shared } }));
	const app = await electron.launch(options);
	try {
		expect(await app.evaluate(() => Reflect.get(globalThis, "__keyFixtureGuard"))).toBe(true);
		const page = await app.firstWindow();
		for (const n of [1, 2]) {
			if (n === 2) {
				await page.keyboard.press("ControlOrMeta+t");
				await expect.poll(() => page.evaluate(() => window.omp.tabs.list().then(tabs => tabs.length))).toBe(2);
			}
			await ready(page);
			const input = page.locator(".omp-composer-input:visible").first();
			// No click that can check a key and no prompt until this session's stock process has installed the guard.
			await expect.poll(() => fake.guards.size).toBe(n);
			const chip = page.locator("[data-model-chip]:visible").first();
			await expect(chip).toContainText(shared);
			await chip.click();
			const auto = page.locator('[data-model-group="claude-api-auto"]');
			await auto.getByRole("option").filter({ hasText: shared }).click();
			await expect(auto).toBeHidden();
			const state = await page.evaluate(async () => (await window.omp.rpc.getState()).data as RpcSessionState);
			expect(state.claudeApiRoute?.provider).toBe(state.model?.provider);
			expect(state.model?.id).toBe(shared);
			await input.fill(`test-key-turn-${n}`);
			await input.press("Enter");
			await expect(page.getByText(`Local answer ${n}`, { exact: true }).first()).toBeVisible({ timeout: 60_000 });
			const account = fake.turns.find(turn => turn.prompt === `test-key-turn-${n}`)?.account;
			expect(account).toBeDefined();
			const actualProvider = account === 0 ? "anthropic-api-key" : "anthropic-api-key-2";
			expect(state.claudeApiRoute?.provider).toBe(actualProvider);
			await expect(page.locator("[data-claude-key-used]").last()).toHaveAttribute(
				"data-claude-key-used",
				actualProvider,
			);
			await expect(page.locator("[data-claude-key-used]").last()).toContainText(`API key ${Number(account) + 1}`);
			await page
				.locator("[data-claude-key-used]")
				.last()
				.screenshot({ path: test.info().outputPath(`served-${n}.png`) });
		}
		expect(fake.turns.map(turn => turn.prompt)).toEqual(["test-key-turn-1", "test-key-turn-2"]);
		expect(fake.posts).toEqual(fake.turns.map(turn => turn.account));
		expect(new Set(fake.turns.map(turn => turn.account)), "Eligible keys actually sent a fresh session").toEqual(
			new Set([0, 1]),
		);
	} finally {
		console.log("#42 loopback request ordinals", {
			verifiedKeys: fake.lists,
			postedKeys: fake.posts,
			sent: fake.turns,
		});
		await exitApp(app);
		fake.close();
	}
});
