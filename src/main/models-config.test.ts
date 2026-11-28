// models.yml through the core and the installed stock omp. The core's own cases (a stand-in stock: the file racing a
// save, symlinks and modes, a missing roster, a misread edit) are in `native/ompdesk/crates/core/src/models/file`.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { CLAUDE_API_URL } from "../../resources/gui-bridge/claude-key-models";
import type { CustomProviderInput } from "../shared/ipc-types";
import { core } from "./core/process";
import {
	deleteModelsProvider,
	extendClaudeKeyModels,
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
import { stockFixtureEnv } from "./test-bridge-probe";

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
		vi.unstubAllGlobals();
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

	test("a stale add cannot replace another window's saved key", async () => {
		const input = { ...minimal, onlyIfAbsent: true as const, apiKey: "dummy-first" };
		await upsertModelsProvider(input);
		await expect(upsertModelsProvider({ ...input, apiKey: "dummy-second" })).rejects.toThrow(/changed_on_disk/);
		expect(saved().providers[input.id].apiKey === input.apiKey).toBe(true);
	});

	test("saves only offered models, preserves stock metadata, and never previews a Claude key", async () => {
		const known = ["claude-sonnet-5", "claude-haiku-5-5"];
		const unknown = { id: "new-probe-model", name: "New model" };
		const input: CustomProviderInput = {
			id: "anthropic-api-key",
			baseUrl: CLAUDE_API_URL,
			api: "anthropic-messages",
			auth: "apiKey",
			apiKey: "offline-probe-key",
			onlyIfAbsent: true,
			models: [],
		};
		const { createServer } = await import("node:http");
		const { createHash } = await import("node:crypto");
		let receivedAt = 0;
		const server = createServer((req, res) => {
			if (
				req.method !== "GET" ||
				req.url?.split("?")[0] !== "/v1/models" ||
				req.headers["x-api-key"] !== input.apiKey
			) {
				res.writeHead(403).end();
				return;
			}
			receivedAt = Date.now();
			res.end(
				JSON.stringify({
					data: [...known.map(id => ({ id })), { id: unknown.id, display_name: unknown.name }],
					has_more: false,
				}),
			);
		});
		const send = globalThis.fetch;
		try {
			const listening = Promise.withResolvers<void>();
			server.once("error", listening.reject).listen(0, "127.0.0.1", listening.resolve);
			await listening.promise;
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing fixture port");
			vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
				if (url.origin !== CLAUDE_API_URL) throw new Error("network disabled");
				return send(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
			});
			await upsertModelsProvider(input);
		} finally {
			server.close();
			server.closeAllConnections();
		}
		const savedAt = Date.now();
		const fingerprint = createHash("sha256").update(input.apiKey!).digest("hex");
		const receipts = join(process.cwd(), "resources/gui-bridge/claude-key-receipts.ts");
		const receiptProbe = `
			import { keyReceipt } from ${JSON.stringify(receipts)};
			const { generation, confirmedAt, models } = keyReceipt(${JSON.stringify(dir)}, ${JSON.stringify(input.id)}, ${JSON.stringify(fingerprint)});
			console.log(JSON.stringify({ generation, confirmedAt, models }));
		`;
		const readReceipt = () =>
			JSON.parse(
				execFileSync("bun", ["-e", receiptProbe], { cwd: dir, encoding: "utf8", env: stockFixtureEnv(dir) }),
			);
		const receipt = readReceipt();
		expect(receivedAt).toBeGreaterThan(0);
		expect(receipt.confirmedAt).toBeGreaterThanOrEqual(receivedAt);
		expect(receipt.confirmedAt).toBeLessThanOrEqual(savedAt);
		expect([...receipt.models].sort()).toEqual([...known, unknown.id].sort());
		const [provider] = await listModelsProviders();
		expect(provider.models.map(model => model.id)).toEqual([...known, unknown.id]);
		const rows = saved().providers[input.id].models;
		expect(rows.at(-1)).toEqual(unknown);
		const root = stock.ok && ompPackageRoot(stock.runtime.bin);
		const probe = `
			globalThis.fetch = Object.assign(() => { throw Error("network disabled"); }, { preconnect() {} });
			const load = name => import(Bun.resolveSync("@oh-my-pi/" + name, ${JSON.stringify(root)}));
			const { AuthStorage } = await load("pi-ai/auth-storage");
			const { getBundledModels } = await load("pi-catalog/models");
			const { ModelRegistry } = await load("pi-coding-agent/config/model-registry");
			const auth = await AuthStorage.create(":memory:");
			try {
				const registry = new ModelRegistry(auth, ${JSON.stringify(file)});
				const shape = ({ reasoning, thinking, supportsTools, input, contextWindow, maxTokens }) =>
					({ reasoning, thinking, supportsTools, input, contextWindow, maxTokens });
				const known = ${JSON.stringify(known)}.map(id => ({
					bundled: shape(getBundledModels("anthropic").find(m => m.id === id)),
					subscriptionThinking: registry.find("anthropic", id).thinking,
					key: shape(registry.find(${JSON.stringify(input.id)}, id)),
				}));
				const fresh = registry.find(${JSON.stringify(input.id)}, ${JSON.stringify(unknown.id)});
				console.log(JSON.stringify({ known, provisional: fresh.thinking?.unverified === true }));
			} finally { auth.close(); }
		`;
		const runtime = JSON.parse(
			execFileSync("bun", ["-e", probe], { cwd: dir, encoding: "utf8", env: stockFixtureEnv(dir) }),
		);
		for (const [i, { bundled, subscriptionThinking, key }] of runtime.known.entries()) {
			expect(key).toEqual(bundled);
			expect(key.thinking).toEqual(subscriptionThinking);
			expect(rows[i]).toMatchObject({
				id: known[i],
				reasoning: true,
				thinking: { mode: "anthropic-adaptive", efforts: bundled.thinking.efforts },
				input: bundled.input,
				contextWindow: bundled.contextWindow,
				maxTokens: bundled.maxTokens,
			});
			expect(rows[i].thinking).not.toHaveProperty("unverified");
		}
		expect(runtime.provisional).toBe(true);
		expect(provider.hasApiKey).toBe(true);
		expect(provider).not.toHaveProperty("apiKeyPreview");
		expect(provider).not.toHaveProperty("apiKey");
		const before = readFileSync(file, "utf8");
		vi.stubGlobal("fetch", () => Response.json({ data: [], has_more: false }));
		await expect(
			upsertModelsProvider({ ...input, onlyIfAbsent: undefined, apiKey: "invalid-dummy" }),
		).rejects.toThrow("[source_unavailable]");
		expect(readFileSync(file, "utf8") === before).toBe(true);
		expect(readReceipt()).toEqual(receipt);
		const slow = Promise.withResolvers<Response>();
		vi.stubGlobal("fetch", () => slow.promise);
		const late = upsertModelsProvider({ ...input, onlyIfAbsent: undefined });
		await deleteModelsProvider(input.id);
		slow.resolve(Response.json({ data: [{ id: "late" }], has_more: false }));
		await expect(late).rejects.toThrow("[changed_on_disk]");
		const forgotten = readReceipt();
		expect(forgotten.models).toEqual([]);
		expect(forgotten.confirmedAt).toBeUndefined();
		expect(forgotten.generation).not.toBe(receipt.generation);
		expect(await listModelsProviders()).toEqual([]);
	});

	test("refresh appends new offers only at the verified config revision and preserves old explicit rows", async () => {
		const id = "anthropic-api-key";
		const legacy = { id: "old-only", name: "Old explicit model" };
		const route = {
			api: "anthropic-messages",
			auth: "apiKey",
			baseUrl: CLAUDE_API_URL,
			apiKey: "dummy-good",
			models: [legacy],
		};
		const second = { ...route, apiKey: "dummy-second" };
		writeFileSync(file, JSON.stringify({ providers: { [id]: route, [`${id}-2`]: second } }));
		const { stamp } = await readModelsText();
		const addition = { id: "new-only", name: "New only" };
		const updated = await extendClaudeKeyModels({ stamp, models: { [id]: [addition] } });
		expect(updated).not.toBe(stamp);
		expect(saved().providers[id].models).toEqual([legacy, addition]);
		expect(saved().providers[`${id}-2`]).toEqual(second);
		const replacement = "# An edit from another window\nproviders: {}\n";
		writeFileSync(file, replacement);
		await expect(extendClaudeKeyModels({ stamp: updated, models: { [id]: [addition] } })).rejects.toThrow(
			/changed_on_disk/,
		);
		expect(readFileSync(file, "utf8")).toBe(replacement);
	});

	test("stock sends a saved key only as x-api-key and verifies legacy catalog rows per key without a paid call", () => {
		const provider = "anthropic-api-key-2";
		const key = "old-offline-probe-key";
		const route = {
			baseUrl: CLAUDE_API_URL,
			api: "anthropic-messages",
			auth: "apiKey",
			apiKey: key,
			models: [{ id: "shared" }, { id: "old-only" }],
		};
		const refused = "anthropic-api-key-3";
		writeFileSync(
			file,
			JSON.stringify({ providers: { [provider]: route, [refused]: { ...route, apiKey: "dummy-refused" } } }),
		);
		const bridge = join(process.cwd(), "resources", "gui-bridge");
		const root = stock.ok && ompPackageRoot(stock.runtime.bin);
		const probe = `
			import { createHash } from "node:crypto";
			import { readFile, unlink, writeFile } from "node:fs/promises";
			import { discoverClaudeKeys, keyAdditionsSaved, keyContextWindow, keyDiscoveryStates, keyOffer } from ${JSON.stringify(join(bridge, "claude-key-catalog.ts"))};
			const dir = ${JSON.stringify(dir)};
			let calls = 0;
			let retry = false;
			let recover = false;
			const started = Promise.withResolvers();
			const release = Promise.withResolvers();
			const send = globalThis.fetch;
			const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
				calls++;
				const good = request.headers.get("x-api-key") === ${JSON.stringify(key)};
				if (retry) {
					started.resolve();
					await release.promise;
					if (recover && !good) return Response.json({ data: [], has_more: false });
				}
				return good && !retry
					? Response.json({ data: [{ id: "shared", max_input_tokens: 123456 }, { id: "new" }], has_more: false })
					: new Response("private provider error", { status: 401 });
			}});
			globalThis.fetch = Object.assign(async (url, init) => {
				if (url.origin + url.pathname !== ${JSON.stringify(`${CLAUDE_API_URL}/v1/models`)} || (init.method ?? "GET") !== "GET") throw Error("network disabled");
				return send(new URL("/v1/models" + url.search, server.url), { ...init, redirect: "error", proxy: null });
			}, { preconnect() {} });
			const load = name => import(Bun.resolveSync("@oh-my-pi/" + name, ${JSON.stringify(root)}));
			const { AuthStorage } = await load("pi-ai/auth-storage");
			const { ModelRegistry } = await load("pi-coding-agent/config/model-registry");
			const { buildAnthropicClientOptions } = await load("pi-ai/providers/anthropic");
			const auth = await AuthStorage.create(":memory:");
			try {
				const registry = new ModelRegistry(auth, ${JSON.stringify(file)});
				const model = registry.find(${JSON.stringify(provider)}, "shared");
				const apiKey = await registry.getApiKey(model);
				const options = buildAnthropicClientOptions({ model, apiKey, isOAuth: model.isOAuth });
				const headers = new Headers(options.defaultHeaders);
				const other = registry.find(${JSON.stringify(refused)}, "shared");
				const session = { settings: { getAgentDir: () => dir }, getAvailableModels: () => [model, other], modelRegistry: registry };
				let now = Date.now();
				const firstTime = now;
				Date.now = () => now;
				const states = () => Object.fromEntries(keyDiscoveryStates(session).map(s => [s.provider, s]));
				const beforeFirstGet = [keyOffer(session, model), keyOffer(session, other)];
				const [additions] = await Promise.all([discoverClaudeKeys(session, false), discoverClaudeKeys(session, false)]);
				now += 1000;
				await discoverClaudeKeys(session, false);
				const initial = [keyOffer(session, model), keyOffer(session, other), keyOffer(session, { ...model, id: "old-only" }), calls];
				const initialStates = states();
				const file = ${JSON.stringify(file)};
				const config = JSON.parse(await readFile(file, "utf8"));
				config.providers[model.provider].models.push(...additions.models[model.provider]);
				const bytes = JSON.stringify(config);
				await writeFile(file, bytes);
				await keyAdditionsSaved(session, additions.stamp, null);
				const conflicted = [keyOffer(session, model), keyDiscoveryStates(session)];
				await keyAdditionsSaved(session, additions.stamp, createHash("sha256").update(bytes).digest("hex"));
				await discoverClaudeKeys(session, false);
				const newModel = registry.find(model.provider, "new");
				const savedOffer = keyOffer(session, newModel);
				const contexts = [keyContextWindow(session, model), keyContextWindow(session, newModel) ?? null, newModel.contextWindow > 0];
				const savedStates = states();
				const oldStock = { ...session, modelRegistry: {} };
				await discoverClaudeKeys(oldStock, false);
				const withoutResolver = keyOffer(oldStock, model);
				retry = true;
				now += 5 * 60_000;
				const refreshing = discoverClaudeKeys(session, false);
				await started.promise;
				const whileRefreshing = keyOffer(session, model);
				const concurrent = discoverClaudeKeys(session, false);
				release.resolve();
				await Promise.all([refreshing, concurrent]);
				const retryStates = states();
				const refusedProof = keyOffer(session, model);
				recover = true;
				await discoverClaudeKeys(session, false, other.provider);
				const recovered = states();
				recover = false;
				const beforeRestart = calls;
				const restarted = { ...session };
				await discoverClaudeKeys(restarted, false);
				const restartStates = Object.fromEntries(keyDiscoveryStates(restarted).map(s => [s.provider, s]));
				const startupReads = calls - beforeRestart;
				await unlink(${JSON.stringify(file)});
				await discoverClaudeKeys(session, false);
				console.log(JSON.stringify({
					keyMatched: headers.get("x-api-key") === ${JSON.stringify(key)},
					bearer: headers.has("authorization"), oauth: options.isOAuthToken,
					initial, additions: additions?.models, refusedProof, withoutResolver, calls: beforeRestart, beforeFirstGet,
					restartStates, startupReads,
					contexts,
					initialStates, savedStates, recovered, retryStates, firstTime, retryTime: now, whileRefreshing, conflicted, savedOffer,
					unrelatedUntouched: keyOffer(session, { ...model, provider: "manual" }) === undefined,
					unreadable: keyOffer(session, model),
				}));
			} finally { auth.close(); server.stop(true); }
		`;
		const output = spawnSync("bun", ["-e", probe], {
			cwd: dir,
			encoding: "utf8",
			env: stockFixtureEnv(dir),
			timeout: 30_000,
		});
		// The probe command contains the synthetic credential. Never include its argv/stderr in an assertion.
		expect(output.status).toBe(0);
		const {
			initialStates,
			savedStates,
			recovered,
			retryStates,
			restartStates,
			startupReads,
			firstTime,
			retryTime,
			...observed
		} = JSON.parse(output.stdout);
		const state = (provider: string, status: string, fetchedAt: number, models: string[]) => ({
			provider,
			status,
			fetchedAt,
			models,
			optional: true,
			stale: false,
		});
		expect(initialStates).toEqual({
			[provider]: state(provider, "ok", firstTime, ["shared", "new"]),
			[refused]: state(refused, "unavailable", firstTime, []),
		});
		expect(savedStates).toEqual(initialStates);
		expect(retryStates).toEqual({
			[provider]: {
				...state(provider, "unavailable", retryTime, ["shared", "new"]),
				stale: true,
				lastConfirmedAt: firstTime,
			},
			[refused]: state(refused, "unavailable", retryTime, []),
		});
		// A new session must GET even with a receipt. Legacy seed IDs never appear in its fallback.
		expect(startupReads).toBe(2);
		expect(restartStates).toEqual({
			...retryStates,
			[refused]: { ...state(refused, "unavailable", retryTime, []), stale: true, lastConfirmedAt: retryTime },
		});
		expect(recovered).toEqual({ ...retryStates, [refused]: state(refused, "empty", retryTime, []) });
		expect(observed).toEqual({
			keyMatched: true,
			bearer: false,
			oauth: false,
			beforeFirstGet: [false, false],
			initial: [true, false, false, 2],
			additions: { [provider]: [{ id: "new", name: "new" }] },
			contexts: [123456, null, true],
			refusedProof: false,
			whileRefreshing: false,
			conflicted: [false, []],
			savedOffer: true,
			withoutResolver: false,
			calls: 5,
			unrelatedUntouched: true,
			unreadable: false,
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
