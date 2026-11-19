import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALL_FEATURES,
	BUNDLED_SCHEME,
	deriveUnavailable,
	FEATURES,
	HEAVY_COPIES,
	hasPath,
	mergeAreaFailures,
	missingFor,
	PRESENCE_ONLY,
	type ProbeSources,
	parseHidden,
	REQUIREMENTS,
	requireFn,
	UnsupportedOmpError,
	unsafeCopies,
} from "../../resources/gui-bridge/capabilities";
import { en } from "../renderer/locales/en";

const BRIDGE_DIR = path.join(__dirname, "..", "..", "resources", "gui-bridge");

/** The stock specifier of every adapter under resources/gui-bridge/omp (`omp/pi-ai.ts` → `@oh-my-pi/pi-ai`). */
function adapterSpecifiers(): string[] {
	return fs
		.readdirSync(path.join(BRIDGE_DIR, "omp"), { recursive: true, encoding: "utf8" })
		.filter(entry => entry.endsWith(".ts"))
		.map(entry => `@oh-my-pi/${entry.split(path.sep).join("/").slice(0, -".ts".length)}`);
}

class FakeStore {
	static open() {}
	upsert() {}
}

/** A session with a method, a getter, an optional getter that is unset, and a nested manager. */
function fakeSession() {
	return {
		setPlanModeState() {},
		get asyncJobManager() {
			return undefined;
		},
		get explodes(): never {
			throw new Error("boom");
		},
		sessionManager: { getCwd: () => "/repo" },
	};
}

function sources(overrides: Partial<ProbeSources> = {}): ProbeSources {
	return {
		session: fakeSession(),
		pkg: { VERSION: "1.0.0" },
		api: { extension: { handlers: new Map() } },
		modules: new Map<string, unknown>([["mod/btw", { BtwHistoryStore: FakeStore, getBtwTurns() {} }]]),
		hasPrompt: relative => relative === "present.md",
		...overrides,
	};
}

describe("hasPath", () => {
	it("requires a function for `()` paths and presence otherwise", () => {
		const session = fakeSession();
		expect(hasPath(session, "setPlanModeState()")).toBe(true);
		expect(hasPath(session, "sessionManager.getCwd()")).toBe(true);
		expect(hasPath(session, "sessionManager")).toBe(true);
		// An optional getter returning undefined still exists.
		expect(hasPath(session, "asyncJobManager")).toBe(true);
		expect(hasPath(session, "asyncJobManager.list()")).toBe(false);
		expect(hasPath(session, "sessionManager()")).toBe(false);
		expect(hasPath(session, "navigateTree()")).toBe(false);
		expect(hasPath(session, "explodes.anything")).toBe(false);
		expect(hasPath({ BtwHistoryStore: FakeStore }, "BtwHistoryStore.prototype.upsert()")).toBe(true);
		expect(hasPath({ BtwHistoryStore: FakeStore }, "BtwHistoryStore.prototype.retry()")).toBe(false);
		expect(hasPath(undefined, "x")).toBe(false);
	});
});

describe("missingFor", () => {
	const requirement = {
		session: ["setPlanModeState()", "navigateTree()", "sessionManager.getLeafId()"],
		pkg: ["VERSION", "AgentRegistry.global()"],
		modules: {
			"mod/btw": ["BtwHistoryStore.open()", "BtwHistoryStore.prototype.retry()", "getBtwTurns()"],
			"mod/gone": ["anything()"],
		},
		prompts: ["present.md", "absent.md"],
	};

	it("labels each missing internal by where it was looked up", () => {
		expect(missingFor(requirement, sources())).toEqual([
			"AgentSession.navigateTree",
			"AgentSession.sessionManager.getLeafId",
			"pi.AgentRegistry.global",
			"mod/btw#BtwHistoryStore.prototype.retry",
			"mod/gone",
			"prompts/absent.md",
		]);
	});

	it("skips session requirements while no session is attached", () => {
		expect(missingFor({ session: ["navigateTree()"] }, sources({ session: undefined }))).toEqual([]);
	});

	it("takes a module whose file is there but was not evaluated as present, and still names one that is gone", () => {
		const lazy = { modules: { "mod/sdk": ["discoverAuthStorage()"], "mod/gone": ["anything()"] } };
		expect(missingFor(lazy, sources())).toEqual(["mod/sdk", "mod/gone"]);
		expect(missingFor(lazy, sources({ unloaded: new Set(["mod/sdk"]) }))).toEqual(["mod/gone"]);
	});

	it("reports hidden labels as missing even when present", () => {
		const hidden = parseHidden(" AgentSession.setPlanModeState , mod/btw#getBtwTurns,,");
		expect([...hidden]).toEqual(["AgentSession.setPlanModeState", "mod/btw#getBtwTurns"]);
		expect(
			missingFor(
				{ session: ["setPlanModeState()"], modules: { "mod/btw": ["getBtwTurns()"] } },
				sources({ hidden }),
			),
		).toEqual(["AgentSession.setPlanModeState", "mod/btw#getBtwTurns"]);
	});

	it("checks the bridge's own ExtensionAPI members (contextHookIdle: the handler table behind pi.on)", () => {
		expect(missingFor(REQUIREMENTS.contextHookIdle, sources())).toEqual([]);
		expect(missingFor(REQUIREMENTS.contextHookIdle, sources({ api: { extension: {} } }))).toEqual([
			"ExtensionAPI.extension.handlers",
		]);
	});
});

describe("deriveUnavailable", () => {
	it("groups missing internals by feature, in the order asked, omitting satisfied features", () => {
		const requirements = {
			planMode: { session: ["setPlanModeState()", "getPlanModeState()"] },
			guidedGoal: { modules: { "mod/btw": ["BtwHistoryStore.open()"] } },
			workspace: { session: ["sessionManager.addWorkspaceDirectory()"] },
		};
		expect(deriveUnavailable(["workspace", "guidedGoal", "planMode"], sources(), requirements)).toEqual([
			{ feature: "workspace", missing: ["AgentSession.sessionManager.addWorkspaceDirectory"] },
			{ feature: "planMode", missing: ["AgentSession.getPlanModeState"] },
		]);
	});

	it("covers every feature with a requirement and a renderer label", () => {
		expect(Object.keys(REQUIREMENTS).sort()).toEqual([...ALL_FEATURES].sort());
		for (const feature of ALL_FEATURES) expect(en[`bridgeHealth.feature.${feature}`], feature).toBeTruthy();
	});

	it("reports composer status unavailable on an omp without the session members it reads", () => {
		const members = ["AgentSession.autoRetryEnabled", "AgentSession.configuredThinkingLevel"];
		const status = { session: REQUIREMENTS.composerState.session };
		expect(missingFor(status, sources({ session: {} }))).toEqual(expect.arrayContaining(members));
		const current = {
			get autoRetryEnabled() {
				return true;
			},
			configuredThinkingLevel() {},
		};
		const missing = missingFor(status, sources({ session: current }));
		for (const member of members) expect(missing).not.toContain(member);
	});

	it("marks only the core capabilities core, so main repairs omp for those alone", () => {
		const requirements = {
			relaunchResume: { session: ["restoreInterruptedTurn()"] },
			abortCompaction: { session: ["abortCompaction()"] },
		};
		expect(deriveUnavailable(["relaunchResume", "abortCompaction"], sources({ session: {} }), requirements)).toEqual([
			{ feature: "relaunchResume", missing: ["AgentSession.restoreInterruptedTurn"], core: true },
			{ feature: "abortCompaction", missing: ["AgentSession.abortCompaction"] },
		]);
		expect(
			mergeAreaFailures([], [{ area: "composer", features: ["relaunchResume", "jobs"], error: "x" }]).map(
				entry => entry.core === true,
			),
		).toEqual([true, false]);
	});
});

describe("one capability per action", () => {
	const AGENT = "@oh-my-pi/pi-coding-agent";

	/** The capabilities a missing internal turns off: every id whose requirements name `label`. */
	function turnedOffBy(label: string): string[] {
		const specifiers = Object.values(REQUIREMENTS).flatMap(requirement => Object.keys(requirement.modules ?? {}));
		const bare = sources({
			session: {},
			pkg: {},
			api: {},
			modules: new Map(specifiers.map(specifier => [specifier, {}])),
			hasPrompt: () => false,
		});
		return ALL_FEATURES.filter(feature => missingFor(REQUIREMENTS[feature], bare).includes(label));
	}

	it("turns off only the action that uses a missing internal, never its whole area", () => {
		expect(turnedOffBy("AgentSession.navigateTree")).toEqual(["switchLeaf"]);
		expect(turnedOffBy("AgentSession.sessionManager.appendLabelChange")).toEqual(["entryLabel"]);
		expect(turnedOffBy("AgentSession.compact")).toEqual(["planApproval"]);
		expect(turnedOffBy("AgentSession.goalRuntime.onBudgetMutated")).toEqual(["goalBudget"]);
		expect(turnedOffBy(`${AGENT}/mcp/config-writer#setMcpServerEnabled`)).toEqual(["mcpToggle"]);
		expect(
			turnedOffBy(`${AGENT}/extensibility/plugins/marketplace#MarketplaceManager.prototype.upgradePlugin`),
		).toEqual(["pluginInstall"]);
		expect(turnedOffBy("AgentSession.refreshScopedModels")).toEqual(["providerLogout"]);
		expect(turnedOffBy("AgentSession.sessionManager.removeWorkspaceDirectory")).toEqual(["workspaceEdit"]);
	});

	it("keeps what only the stock helper loads out of the bridge's own actions", () => {
		expect(turnedOffBy(`${AGENT}/extensibility/plugins/manager#PluginManager.prototype.upgrade`)).toEqual([
			"extensionUpdates",
		]);
		expect(turnedOffBy(`${AGENT}/sdk#discoverAuthStorage`)).toEqual(["storedCredentials"]);
		expect(turnedOffBy(`${AGENT}/session/session-manager#SessionManager.prototype.moveTo`)).toEqual([
			"moveStoredSession",
		]);
	});

	it("lists a shared helper's internals under every action that runs it", () => {
		// Stock's MCP reload runs after a remove, an add, a sign-in and a reload; /copy and /open replay the transcript.
		expect(turnedOffBy("AgentSession.setMCPPromptCommands")).toEqual([
			"mcpRemove",
			"mcpAdd",
			"mcpReauth",
			"mcpReload",
		]);
		expect(turnedOffBy(`${AGENT}/session/session-context#buildSessionContext`)).toEqual([
			"copyTargets",
			"lastLink",
			"transcript",
		]);
	});
});

describe("mergeAreaFailures", () => {
	it("marks every feature of a module that failed to load", () => {
		expect(
			mergeAreaFailures(
				[{ feature: "voice", missing: ["@x/stt#sttClient"] }],
				[{ area: "misc", features: ["voice", "ssh"], error: "Export named 'sttClient' not found" }],
			),
		).toEqual([
			{
				feature: "voice",
				missing: ["@x/stt#sttClient", "gui-bridge/misc.ts failed to load: Export named 'sttClient' not found"],
			},
			{ feature: "ssh", missing: ["gui-bridge/misc.ts failed to load: Export named 'sttClient' not found"] },
		]);
	});
});

describe("UnsupportedOmpError / requireFn", () => {
	it("names the feature and the missing internal under the unsupported_omp code", () => {
		const error = new UnsupportedOmpError(
			[{ feature: "planMode", missing: ["AgentSession.setPlanModeState"] }],
			"19.0.0",
		);
		expect(error.code).toBe("unsupported_omp");
		expect(error.message).toContain(`omp 19.0.0: ${FEATURES.planMode} (missing AgentSession.setPlanModeState)`);
		expect(error.message).toContain("OMPdesk updates omp by itself");
	});

	it("throws only when the method is absent", () => {
		expect(() => requireFn(fakeSession(), "setPlanModeState", "planMode")).not.toThrow();
		expect(() => requireFn(fakeSession(), "navigateTree", "switchLeaf")).toThrow(
			expect.objectContaining({
				code: "unsupported_omp",
				message: expect.stringContaining("AgentSession.navigateTree"),
			}),
		);
		expect(() => requireFn({}, "getUsageStatistics", "usage", "SessionManager")).toThrow(
			/SessionManager\.getUsageStatistics/,
		);
	});
});

describe("health.ts loaders", () => {
	it("has a literal loader for every module the table names", () => {
		// omp only maps literal `@oh-my-pi/*` specifiers onto its live modules, so health.ts
		// spells each one out; a module without a loader would read as missing.
		const source = fs.readFileSync(path.join(BRIDGE_DIR, "health.ts"), "utf8");
		const loaders = [...source.matchAll(/"([^"]+)": \(\) =>\s*import\("([^"]+)"\)/g)];
		for (const [, key, specifier] of loaders) expect(specifier).toBe(key);
		const required = new Set(
			Object.values(REQUIREMENTS).flatMap(requirement => Object.keys(requirement.modules ?? {})),
		);
		expect(new Set(loaders.map(([, key]) => key))).toEqual(required);
	});

	it("covers every stock module the extension imports, so the copy check sees them all", () => {
		// Bridge code inside omp reaches stock only through resources/gui-bridge/omp/<subpath>.ts adapters
		// (scripts/lint-omp-imports.mjs); the stock helper, stats host and boot model use omp-package.ts in their own
		// Bun processes.
		const required = new Set([
			...Object.values(REQUIREMENTS).flatMap(requirement => Object.keys(requirement.modules ?? {})),
			// thinking-default.ts feature-detects the natives addon (a package root omp bundles) instead of requiring it.
			"@oh-my-pi/pi-natives",
		]);
		const adapters = adapterSpecifiers();
		expect(adapters.length).toBeGreaterThan(0);
		expect(adapters.filter(specifier => !required.has(specifier))).toEqual([]);
	});

	it("keeps the stock source copies that pull a large module graph off the startup path", () => {
		// Measured on Windows (omp 18.12.3, bun 1.4.3, warm): the first static import of any of these makes bun
		// transpile omp's source tree inside the omp process, ~540 ms of its only thread before `ready`; with a cold
		// transpiler cache the same load takes seconds. Every area module loads at startup, so these load on use.
		const heavy = new Set(
			[
				"@oh-my-pi/pi-coding-agent/config",
				"@oh-my-pi/pi-coding-agent/tts/models",
				"@oh-my-pi/pi-coding-agent/tts/tts-client",
				"@oh-my-pi/pi-coding-agent/tts/wav",
			].map(specifier => `omp/${specifier.slice("@oh-my-pi/".length)}`),
		);
		const outside = new Set(["stock-helper", "stats-host.ts", "boot-model.ts", "health.ts", "omp"]);
		const eager: string[] = [];
		for (const entry of fs.readdirSync(BRIDGE_DIR, { recursive: true, encoding: "utf8" })) {
			const file = entry.split(path.sep).join("/");
			if (!file.endsWith(".ts") || outside.has(file.split("/")[0] ?? "")) continue;
			const source = fs.readFileSync(path.join(BRIDGE_DIR, entry), "utf8");
			for (const match of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gms)) {
				const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] ?? ""));
				if (heavy.has(target)) eager.push(`${file}: ${target}`);
			}
		}
		expect(eager).toEqual([]);
	});

	it("evaluates a presence-only copy in no omp: no bridge adapter re-exports one, and each is a heavy copy", () => {
		// guard never evaluates these (health.ts probe): `sdk` on `providers`' first call held omp's thread ~1.1 s
		// right after a tab's ready. Only the stock helper, in its own process, may load them (omp-package.ts).
		const adapters = new Set(adapterSpecifiers());
		for (const specifier of Object.keys(PRESENCE_ONLY)) {
			expect(HEAVY_COPIES, specifier).toHaveProperty([specifier]);
			expect(adapters.has(specifier), specifier).toBe(false);
		}
	});
});

describe("separate copies of stock", () => {
	const bundled = (key: string) => `${BUNDLED_SCHEME}${key}`;

	it("refuses a copy outside COPY_SAFE once omp serves anything from its bundle", () => {
		const copies = unsafeCopies({
			"@oh-my-pi/pi-coding-agent/config/registry": bundled("@oh-my-pi/pi-coding-agent/config/registry"),
			"@oh-my-pi/pi-coding-agent/goals/settings": "file:///omp/pi-coding-agent/src/goals/settings.ts",
			"@oh-my-pi/pi-coding-agent/tiny/text": "file:///omp/pi-coding-agent/src/tiny/text.ts",
		});
		expect([...copies]).toEqual(["@oh-my-pi/pi-coding-agent/goals/settings"]);
	});

	it("sees no copy on an omp run from source, where every import shares one graph", () => {
		const copies = unsafeCopies({
			"@oh-my-pi/pi-coding-agent/config/registry": "file:///omp/pi-coding-agent/src/config/registry.ts",
			"@oh-my-pi/pi-coding-agent/goals/settings": "file:///omp/pi-coding-agent/src/goals/settings.ts",
		});
		expect(copies.size).toBe(0);
	});

	it("names a refused copy as the missing internal of each feature that needs it", () => {
		const requirement = { modules: { "mod/copied": ["read()"], "mod/btw": ["getBtwTurns()"] } };
		const modules = new Map<string, unknown>([
			["mod/copied", { read() {} }],
			["mod/btw", { getBtwTurns() {} }],
		]);
		expect(missingFor(requirement, sources({ modules, copies: new Set(["mod/copied"]) }))).toEqual([
			"mod/copied (separate copy, not this omp's module)",
		]);
	});
});
