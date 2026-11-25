// models.yml through the core and the installed stock omp. The core's own cases (a stand-in stock: the file racing a
// save, symlinks and modes, a missing roster, a misread edit) are in `native/ompdesk/crates/core/src/models/file`.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parse } from "yaml";
import type { CustomProviderInput } from "../shared/ipc-types";
import { core } from "./core/process";
import {
	deleteModelsProvider,
	listModelsProviders,
	modelsCatalog,
	modelsPath,
	readModelsText,
	setModelOverride,
	upsertModelsProvider,
	writeModelsText,
} from "./models-config";
import { ompPackageRoot, systemOmp } from "./omp-runtime";
import { CustomProviderInputSchema } from "./remote/app-protocol";
import { stockHelperHost, stopStockHelper } from "./stock-helper";

const stock = await systemOmp();
const available = stock.ok && ompPackageRoot(stock.runtime.bin) !== null;
const minimal: CustomProviderInput = {
	id: "test-provider",
	api: "openai-completions",
	baseUrl: "https://api.test/v1",
	models: [{ id: "model-a" }],
};

describe.skipIf(!available)("models.yml through installed stock", () => {
	let dir: string;
	let file: string;
	let original: string | undefined;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-models-stock-"));
		file = join(dir, "models.yml");
		original = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	afterEach(() => {
		stopStockHelper();
		if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = original;
		rmSync(dir, { recursive: true, force: true });
	});
	const saved = () => parse(readFileSync(file, "utf8"));

	test("derives the full stock roster and option vocabularies", async () => {
		const { options } = await modelsCatalog();
		expect(options).toMatchObject({ builtinProviders: expect.arrayContaining(["openai-codex-device"]) });
		expect(options.apis).toContain("anthropic-messages");
		expect(options.apis).toContain("typesafe");
		expect(options.auth).toContain("oauth");
		expect(options.discovery).toContain("apple-foundation-models");
		expect(options.thinkingModes).toContain("anthropic-budget-effort");
		expect(options.efforts).toContain("max");
	});

	test("round-trips models and discovery-only providers", async () => {
		await upsertModelsProvider(minimal);
		await upsertModelsProvider({
			...minimal,
			id: "messages",
			api: "anthropic-messages",
			discovery: { type: "openai-models-list" },
			models: [],
		});
		const providers = await listModelsProviders();
		expect(providers.find(provider => provider.id === minimal.id)).toMatchObject({ ...minimal, builtin: false });
		expect(providers.find(provider => provider.id === "messages")).toMatchObject({
			api: "anthropic-messages",
			discovery: { type: "openai-models-list" },
			models: [],
		});
	});

	test("accepts the entry the local engine detector writes and lists it as discovery-only", async () => {
		// What `models/detect.rs` writes for an engine that answers, with its only-if-absent upsert.
		const engine = {
			id: "freetoken",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1919/v1",
			auth: "none",
			discovery: { type: "openai-models-list" },
			models: [],
		};
		const insert = async () =>
			(
				await core().call<boolean>("models.upsert", {
					dir,
					host: stockHelperHost(),
					input: engine,
					onlyIfAbsent: true,
				})
			).result;
		expect(await insert()).toBe(true);
		expect(saved().providers.freetoken).toEqual({
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1919/v1",
			auth: "none",
			discovery: { type: "openai-models-list" },
			models: [],
		});
		expect((await listModelsProviders()).find(provider => provider.id === "freetoken")).toMatchObject({
			auth: "none",
			discovery: { type: "openai-models-list" },
			builtin: false,
		});
		await deleteModelsProvider("freetoken");
		expect((await listModelsProviders()).some(provider => provider.id === "freetoken")).toBe(false);
		// The person's own entry with that id is never replaced, whichever of the two edits the core runs first.
		const own = { ...minimal, id: "freetoken", baseUrl: "http://127.0.0.1:1919/v1", apiKey: "sk-own" };
		await Promise.all([upsertModelsProvider(own), insert()]);
		expect(saved().providers.freetoken).toMatchObject({ api: own.api, apiKey: "sk-own" });
		expect(await insert()).toBe(false);
		expect(saved().providers.freetoken).toMatchObject({ apiKey: "sk-own" });
	});

	test("keeps a key unless explicitly cleared and never exposes it in a list", async () => {
		await upsertModelsProvider({ ...minimal, apiKey: "sk-original-secret" });
		await upsertModelsProvider({ ...minimal, baseUrl: "https://api.test/v2" });
		expect(saved().providers[minimal.id].apiKey).toBe("sk-original-secret");
		const view = (await listModelsProviders())[0];
		expect(view.hasApiKey).toBe(true);
		expect(view).not.toHaveProperty("apiKey");
		await upsertModelsProvider({ ...minimal, clearApiKey: true });
		expect(saved().providers[minimal.id]).not.toHaveProperty("apiKey");
	});

	test("preserves unrendered provider/model/compat fields and comments", async () => {
		writeFileSync(
			file,
			`# Company gateway
providers:
  untouched: # Leave this provider alone
    api: openai-completions
    baseUrl: https://legacy.test/v1
  test-provider:
    api: openai-completions
    baseUrl: https://api.test/v1 # Keep this endpoint comment
    remoteCompaction: {enabled: true, model: compact-model}
    modelOverrides: {model-a: {contextWindow: 128000}}
    compat: {supportsStore: true, extraBody: {seed: 42}}
    models:
      - id: model-a
        compactionModel: compact-model
        thinking: {mode: effort, efforts: [low, high], effortMap: {low: low}, requiresEffort: true}
        cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}
`,
		);
		const view = (await listModelsProviders()).find(provider => provider.id === minimal.id);
		if (!view) throw new Error("Missing test provider");
		await upsertModelsProvider({
			...minimal,
			baseUrl: "https://api.test/v2",
			extraBody: { temperature: 0.5 },
			models: [{ ...view.models[0], name: "Renamed" }],
		});
		const text = readFileSync(file, "utf8");
		const entry = parse(text).providers[minimal.id];
		expect(text).toContain("# Company gateway");
		expect(text).toContain("Leave this provider alone");
		expect(text).toContain("https://api.test/v2 # Keep this endpoint comment");
		expect(entry.remoteCompaction).toEqual({ enabled: true, model: "compact-model" });
		expect(entry.modelOverrides).toEqual({ "model-a": { contextWindow: 128000 } });
		expect(entry.compat).toEqual({ supportsStore: true, extraBody: { temperature: 0.5 } });
		expect(entry.models[0]).toMatchObject({
			name: "Renamed",
			compactionModel: "compact-model",
			thinking: { effortMap: { low: "low" }, requiresEffort: true },
		});
	});

	test("normalizes legacy thinking ranges through stock", async () => {
		writeFileSync(
			file,
			`providers:
  test-provider:
    api: openai-completions
    baseUrl: https://api.test/v1
    models:
      - id: ranged
        thinking: {mode: effort, minLevel: low, maxLevel: high}
      - id: levelled
        thinking: {mode: budget, levels: [minimal, medium], effortMap: {minimal: low}}
`,
		);
		const view = (await listModelsProviders())[0];
		expect(view.models[0].thinking?.efforts).toEqual(["low", "medium", "high"]);
		expect(view.models[1].thinking?.efforts).toEqual(["minimal", "medium"]);
		await upsertModelsProvider({ ...minimal, models: view.models });
		const models = saved().providers[minimal.id].models;
		expect(models[0].thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high"] });
		expect(models[1].thinking).toEqual({
			mode: "budget",
			efforts: ["minimal", "medium"],
			effortMap: { minimal: "low" },
		});
	});

	test("refuses invalid stock shapes without modifying the file or exposing secrets", async () => {
		await upsertModelsProvider(minimal);
		const before = readFileSync(file, "utf8");
		const shapeless = upsertModelsProvider({
			...minimal,
			apiKey: "do-not-log",
			models: [{ id: "", cost: { input: 1 } }],
		});
		await expect(shapeless).rejects.toThrow("ModelsConfigSchema");
		await expect(shapeless).rejects.not.toThrow("do-not-log");
		await expect(
			upsertModelsProvider(CustomProviderInputSchema.parse({ ...minimal, api: "not-a-stock-api" })),
		).rejects.toThrow("ModelsConfigSchema");
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("rejects all catalog built-ins and marks hand-written overrides", async () => {
		for (const id of ["openai", "anthropic", "openai-codex-device", "zai-coding-plan", "gitlab-duo-agent"]) {
			await expect(upsertModelsProvider({ ...minimal, id })).rejects.toThrow("[provider_id_builtin]");
			await expect(deleteModelsProvider(id)).rejects.toThrow("[provider_builtin_delete]");
		}
		writeFileSync(file, "providers:\n  anthropic:\n    baseUrl: https://gateway.test\n");
		expect((await listModelsProviders())[0].builtin).toBe(true);
	});

	test("serializes concurrent provider edits", async () => {
		await Promise.all([upsertModelsProvider(minimal), upsertModelsProvider({ ...minimal, id: "second-provider" })]);
		expect((await listModelsProviders()).map(provider => provider.id).sort()).toEqual([
			"second-provider",
			"test-provider",
		]);
	});

	test("writes atomically to the preferred path and removes custom entries", async () => {
		await upsertModelsProvider(minimal);
		expect(readdirSync(dir)).toEqual(["models.yml"]);
		expect(await modelsPath()).toBe(file);
		await deleteModelsProvider(minimal.id);
		expect(await listModelsProviders()).toEqual([]);
		expect(saved()).toEqual({ providers: {} });
	});

	test("keeps writing models.yaml while only that exists", async () => {
		const legacy = join(dir, "models.yaml");
		writeFileSync(legacy, "providers: {}\n");
		expect(await modelsPath()).toBe(legacy);
		await upsertModelsProvider(minimal);
		expect(readdirSync(dir)).toEqual(["models.yaml"]);
		expect(parse(readFileSync(legacy, "utf8")).providers).toHaveProperty(minimal.id);
	});

	test("writes a built-in model's overrides, keeps unrendered keys, and a reset leaves no entry", async () => {
		writeFileSync(
			file,
			`providers:
  anthropic:
    modelOverrides:
      claude-x:
        cost: {input: 1, output: 2, cacheRead: 0, cacheWrite: 0}
        compat: {supportsStore: false}
`,
		);
		await setModelOverride("anthropic", "claude-x", {
			contextWindow: 64_000,
			maxTokens: 8_000,
			api: "anthropic-messages",
			thinking: { mode: "effort", efforts: ["low", "high"], effortMap: { high: "max" } },
			replayReasoning: true,
		});
		expect(saved().providers.anthropic.modelOverrides["claude-x"]).toMatchObject({
			contextWindow: 64_000,
			maxTokens: 8_000,
			cost: { input: 1, output: 2 },
			compat: { supportsStore: false, requiresReasoningContentForToolCalls: true },
			thinking: { mode: "effort", efforts: ["low", "high"], effortMap: { high: "max" } },
		});
		const view = (await listModelsProviders()).find(provider => provider.id === "anthropic");
		expect(view?.builtin).toBe(true);
		expect(view?.modelOverrides?.["claude-x"]).toEqual({
			api: "anthropic-messages",
			contextWindow: 64_000,
			maxTokens: 8_000,
			thinking: { mode: "effort", efforts: ["low", "high"], effortMap: { high: "max" } },
			replayReasoning: true,
		});
		// Clearing every rendered field keeps the hand-written keys.
		await setModelOverride("anthropic", "claude-x", {});
		expect(saved().providers.anthropic.modelOverrides["claude-x"]).toEqual({
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false },
		});
		await setModelOverride("anthropic", "claude-x", null);
		expect(saved().providers ?? {}).not.toHaveProperty("anthropic");
	});

	test("the in-app editor's save is checked by stock's own reader", async () => {
		const opened = await readModelsText();
		expect(opened).toMatchObject({ path: file, exists: false, text: "# Custom model providers.\nproviders: {}\n" });
		// Bun.YAML, stock's reader, refuses tab indentation, which yaml-edit alone would accept.
		await expect(writeModelsText("providers:\n\ttest-provider: {}\n", opened.stamp)).rejects.toThrow(
			"[invalid_content]",
		);
		await expect(writeModelsText("providers:\n  a: {api: x}\n  a: {api: y}\n", opened.stamp)).rejects.toThrow(
			"unique",
		);
		const typed =
			"# mine\nproviders:\n  test-provider:\n    api: openai-completions\n    baseUrl: https://api.test/v1\n    models:\n      - id: m\n        thinking: {mode: effort, minLevel: low, maxLevel: high}\n";
		const stamp = await writeModelsText(typed, opened.stamp);
		const reopened = await readModelsText();
		expect(reopened.stamp).toBe(stamp);
		expect(reopened.text.startsWith("# mine\n")).toBe(true);
		expect(parse(reopened.text).providers["test-provider"].models[0].thinking.efforts).toEqual([
			"low",
			"medium",
			"high",
		]);
		await expect(writeModelsText(typed, opened.stamp)).rejects.toThrow("changed on disk");
	});
});
