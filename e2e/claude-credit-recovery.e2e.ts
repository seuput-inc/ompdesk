/** Real shell, stock process and HTTP receiver. bridge-claude-api-route-stock.test.ts covers in-budget same-key retries. */
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import type { RpcSessionState } from "../src/shared/rpc-types";
import { guardProvider, profile, provider, ready, seedKeyModels, shared } from "./claude-key-fixture";
import { exitApp } from "./harness";

const refusals = {
	lowCredit: {
		status: 400,
		error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API" },
	},
	monthly: {
		status: 429,
		error: {
			type: "rate_limit_error",
			message: "Monthly spend limit reached",
			details: { error_code: "enforced_spend_limit_reached" },
		},
	},
	transient: { status: 429, error: { type: "rate_limit_error", message: "Too many requests" } },
};

for (const scenario of ["lowCredit", "monthly", "transient", "lost response"] as const) {
	test(`${scenario}: restarting and choosing another Claude key never resends the first turn`, async () => {
		test.skip(
			process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted",
			"Isolated Windows stock host only",
		);
		test.setTimeout(240_000);
		const { options, agent, project } = await profile(true);
		const fake = await provider(res => {
			if (scenario === "lost response") {
				res.destroy();
				return;
			}
			const { status, error } = refusals[scenario];
			if (scenario === "transient") res.setHeader("retry-after", "86400"); // Outside stock's same-key retry budget.
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error }));
		});
		try {
			await guardProvider(project, options.env, fake.origin);
			await seedKeyModels(agent);
			const app = await electron.launch(options);
			let expectedPosts = 0;
			try {
				expect(await app.evaluate(() => Reflect.get(globalThis, "__keyFixtureGuard"))).toBe(true);
				const page = await app.firstWindow();
				await ready(page);
				await expect.poll(() => fake.guards.size).toBe(1);
				const chip = page.locator("[data-model-chip]:visible").first();
				await expect(chip).toContainText(shared);
				await chip.click();
				const auto = page.locator('[data-model-group="claude-api-auto"]');
				await auto.getByRole("option").filter({ hasText: shared }).click();
				await expect(auto).toBeHidden();
				const state = () => page.evaluate(async () => (await window.omp.rpc.getState()).data as RpcSessionState);
				const providers = ["anthropic-api-key", "anthropic-api-key-2"];
				const route = (await state()).claudeApiRoute?.provider;
				expect(providers).toContain(route);
				const selected = providers.indexOf(route ?? "");
				const other = 1 - selected;
				const first = { prompt: "test-key-turn-1", account: selected };
				const input = page.locator(".omp-composer-input:visible").first();
				await input.fill(first.prompt);
				await input.press("Enter");
				await expect.poll(() => fake.turns, { timeout: 60_000 }).toEqual([first]);
				if (scenario !== "lost response") {
					const notice = page.locator("[data-claude-refusal]");
					await expect(notice).toContainText(en[`chat.claudeApi.refusal.${scenario}`].split("{key}")[0]);
					await expect(notice).toContainText(
						en[scenario === "lowCredit" ? "chat.claudeApi.sharedBalance" : "chat.claudeApi.sharedLimit"],
					);
				}
				const idle = { isSettled: true, queuedMessageCount: 0 };
				await expect.poll(state, { timeout: 60_000 }).toMatchObject(idle);
				const { sessionId, sessionFile } = await state();
				expect(sessionId).toBeTruthy();
				expect(sessionFile).toBeTruthy();
				const beforeRestart = fake.posts.length;
				expect(beforeRestart).toBe(fake.hints.length + 1);
				await page.evaluate(() => window.omp.sidecar.restart());
				await expect.poll(() => fake.guards.size, { timeout: 90_000 }).toBe(2);
				await ready(page);
				await expect.poll(state).toMatchObject({ ...idle, sessionId, sessionFile, model: { provider: route } });
				await chip.click();
				const explicit = page
					.locator(`[data-model-group="${providers[other]}"]`)
					.getByRole("option")
					.filter({ hasText: shared });
				await expect(explicit).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(explicit).toBeHidden();
				await expect.poll(state).toMatchObject({ model: { provider: route } });
				await chip.click();
				await explicit.click();
				await expect.poll(state).toMatchObject({ ...idle, model: { provider: providers[other], id: shared } });
				expect(fake.posts).toHaveLength(beforeRestart);
				const second = { prompt: "test-key-turn-2", account: other };
				await input.fill(second.prompt);
				await input.press("Enter");
				await expect(page.getByText("Local answer 2", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
				await expect.poll(state).toMatchObject({ ...idle, sessionId, sessionFile });
				expect(fake.turns).toEqual([first, second]);
				expectedPosts = beforeRestart + 1;
			} finally {
				await exitApp(app);
			}
			expect(fake.posts).toHaveLength(expectedPosts);
		} finally {
			fake.close();
		}
	});
}
