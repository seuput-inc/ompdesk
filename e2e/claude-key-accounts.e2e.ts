/** Real key management and session selection against a strictly local, key-specific Claude API. */
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { en } from "../src/renderer/locales/en";
import type { RpcSessionState, RpcSkillsResult } from "../src/shared/rpc-types";
import { guardProvider, keys, offered, profile, provider, ready, seedKeyModels, shared } from "./claude-key-fixture";
import { exitApp, pressShortcutUntilVisible } from "./harness";

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
	await seedKeyModels(agent);
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
		expect(fake.posts.length, "Every POST is a user turn or a stock skill description").toBe(2 + fake.hints.length);
		const eligibleSkills = await page.evaluate(async () => {
			const response = await window.omp.rpc.getSkills();
			if (!response.success) throw new Error(response.error);
			return (response.data as RpcSkillsResult).skills
				.filter(s => s.enabled && !s.hidden && s.description.replace(/\s+/g, " ").trim().length > 100)
				.map(s => s.name);
		});
		const coldProcess = [...fake.guards][0];
		expect(fake.hints.length, "Cold profile requests stock routing hints").toBeGreaterThan(0);
		expect(new Set(fake.hints.map(h => h.skill)).size, "No skill is compressed twice").toBe(fake.hints.length);
		for (const hint of fake.hints) {
			expect(eligibleSkills).toContain(hint.skill);
			expect(hint).toMatchObject({ account: 0, model: shared });
			expect(`/guard/${hint.process}`, "Warm session sends no compression requests").toBe(coldProcess);
		}
		expect(new Set(fake.turns.map(turn => turn.account)), "Eligible keys actually sent a fresh session").toEqual(
			new Set([0, 1]),
		);
	} finally {
		console.log("#42 loopback request ordinals", {
			verifiedKeys: fake.lists,
			postedKeys: fake.posts,
			sent: fake.turns,
			skillDescriptions: fake.hints,
		});
		await exitApp(app);
		fake.close();
	}
});
