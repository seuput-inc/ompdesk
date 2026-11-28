import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AutoTitleSettings } from "../../resources/gui-bridge/modes/auto-title-contracts";
import type { NextPromptSettings } from "../../resources/gui-bridge/modes/next-prompt-contracts";
import { BridgeHealth } from "./bridge-health";
import { setControlEndpoint } from "./control-socket/env";
import { SessionKindStore } from "./session-kinds";
import type { SidecarOptions } from "./sidecar";
import { localSidecarFactory } from "./sidecar-factory";

const ALWAYS = [
	"-e",
	path.join("/builtin", "formal"),
	"-e",
	path.join("/builtin", "interfaces"),
	"-e",
	path.join("/builtin", "matt"),
	"-e",
	path.join("/bridge", "ponytail.ts"),
];
const created = vi.hoisted(() => [] as SidecarOptions[]);
const sidecars = vi.hoisted(() => [] as Array<{ listeners: Map<string, Array<(arg: unknown) => void>> }>);

// The factory only builds options; what a SidecarManager does with them is sidecar.test.ts's.
vi.mock("./sidecar", () => ({
	SidecarManager: class {
		readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
		constructor(options: SidecarOptions) {
			created.push(options);
			sidecars.push(this);
		}
		on(event: string, listener: (arg: unknown) => void): this {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
	},
}));
// i18n opens the Electron prefs store on import.
vi.mock("./i18n", () => ({ ompFailureText: (reason: string) => reason }));
vi.mock("electron", () => ({ app: {} }));

describe("localSidecarFactory", () => {
	it("isolates the local bot launch while ordinary and hosted tabs keep their launch profile", async () => {
		let stored: string[] = ["--no-rules"];
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			delegationPref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => stored,
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			// Read per spawn, not captured at creation.
			stored = ["--no-rules"];
			expect(options.launchFlags?.("/w/alpha")).toEqual(["--no-rules"]);
			stored = [];
			expect(options.botChatId).toBeUndefined();
			expect(options.launchFlags?.("/w/alpha")).toEqual([]);
		}
		const launch = { botChatId: "bot", botChatPort: 8, botChatSessionPath: "/s/home" };
		create("/w/alpha", "agent", false, undefined, false, launch);
		const bot = created.at(-1);
		expect(bot).toMatchObject(launch);
		expect(await bot?.sessionFree?.("/s/home")).toBe("owned");
		expect(() => create("/w/alpha", "agent", false, undefined, true, launch)).toThrow();
		expect(() =>
			create("/w/alpha", "agent", false, { deviceId: "p", name: "P", hostName: "H" }, false, launch),
		).toThrow();
	});

	it("hands every tab the prompt-suggestion switches, read per use, so a hosted tab follows this machine's pref", () => {
		let stored: NextPromptSettings = { suggestions: true, inline: true };
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => stored,
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			expect(options.nextPrompt?.()).toEqual({ suggestions: true, inline: true });
			stored = { suggestions: true, inline: false };
			expect(options.nextPrompt?.()).toEqual({ suggestions: true, inline: false });
			stored = { suggestions: true, inline: true };
		}
	});

	it("hands every tab the automatic-title switches, read per use, so a hosted tab follows this machine's pref", () => {
		let stored: AutoTitleSettings = { enabled: true, evolve: true, suppressed: false };
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => stored,
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			expect(options.autoTitle?.()).toEqual({ enabled: true, evolve: true, suppressed: false });
			stored = { enabled: true, evolve: false, suppressed: false };
			expect(options.autoTitle?.()).toEqual({ enabled: true, evolve: false, suppressed: false });
			stored = { enabled: true, evolve: true, suppressed: false };
		}
	});

	it("hands every tab the judge-assist switch, read per use, so a hosted tab follows this machine's pref", () => {
		let stored = true;
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => stored,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		expect(created).toHaveLength(2);
		for (const options of created) {
			stored = true;
			expect(options.judgeAssist?.()).toBe(true);
			stored = false;
			expect(options.judgeAssist?.()).toBe(false);
		}
	});

	it("tells only this computer's own tabs where the control socket is; a paired device's or the phone page's tab is told it is off", () => {
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			wslProfile: "/profile",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});
		setControlEndpoint({ socket: "/s/control.sock", dir: "/s" });
		try {
			create("/w/alpha", "agent", false);
			create("/w/alpha", "agent", false, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
			create("/w/alpha", "agent", false, undefined, true);
			const [own, device, phone] = created.map(options => options.controlEnv?.());
			expect(own).toEqual({ OMPDESK_SOCKET: "/s/control.sock", OMPDESK_CONTROL_DIR: "/s" });
			expect(device).toEqual({ OMPDESK_CONTROL_OFF: "1" });
			expect(phone).toEqual({ OMPDESK_CONTROL_OFF: "1" });
			const tag = created[0]?.wslProject?.tabTag;
			expect(tag).toHaveLength(32);
			expect(created[1]?.wslProject).toBeUndefined();
			expect(created[2]?.wslProject).toBeUndefined();
			create("/w/alpha", "agent", true, undefined, false, undefined, undefined, undefined, tag);
			expect(created[3]?.wslProject).toMatchObject({ tabTag: tag, resumePending: true });
			create("/w/alpha", "agent", true, undefined, false, undefined, undefined, undefined, null);
			expect(created[4]?.wslProject).toBeUndefined();
		} finally {
			setControlEndpoint(null);
		}
	});

	it.each([
		[undefined, "agent", true, "1"],
		[true, "agent", true, "1"],
		[true, "chat", true, "0"],
		[false, "agent", false, "0"],
	] as const)("loads the pstack pack only while the switch is on (pref %s, %s)", async (stored, kind, on, flag) => {
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			pstackPref: () => stored,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});
		create("/w/alpha", kind, false);
		const mcp = await created[0]?.builtinMcp?.();
		expect(mcp?.args).toEqual([...(on ? ["-e", path.join("/builtin", "pstack")] : []), ...ALWAYS]);
		expect(mcp?.env).toEqual({ OMP_GUI_PSTACK: flag, OMP_GUI_ECC: "0", PONYTAIL_DEFAULT_MODE: "full" });
	});

	it.each([
		[undefined, "agent", true, "1"],
		[true, "chat", true, "0"],
		[false, "agent", false, "0"],
		[false, "chat", false, "0"],
	] as const)(
		"loads the ECC root only while its switch is on, its hint for a project (pref %s, %s)",
		async (stored, kind, on, flag) => {
			created.length = 0;
			const create = localSidecarFactory({
				bridgeDir: "/bridge",
				builtinDir: "/builtin",
				eccPref: () => stored,
				proxyEnv: async () => ({}),
				bridgeHealth: new BridgeHealth(() => {}),
				sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
				replyLanguagePref: () => undefined,
				userProfilePref: () => undefined,
				nextPromptPrefs: () => ({ suggestions: true, inline: true }),
				autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
				judgeAssistPref: () => true,
				delegationPref: () => undefined,
				accountRotationPref: () => undefined,
				accountRotationLedger: "/ledger.json",
				launchFlags: () => [],
			});
			create("/w/alpha", kind, false);
			const mcp = await created[0]?.builtinMcp?.();
			expect(mcp?.args).toEqual([...(on ? ["-e", path.join("/builtin", "ecc")] : []), ...ALWAYS]);
			expect(mcp?.env).toEqual({ OMP_GUI_PSTACK: "0", OMP_GUI_ECC: flag, PONYTAIL_DEFAULT_MODE: "full" });
		},
	);

	it("hands every spawn ai-memory's extension root while memory is on, read at each spawn (tabs and hosted tabs alike)", async () => {
		let args: string[] = ["-e", "/ud/ai-memory/omp-ext"];
		const asked: string[] = [];
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
			aiMemoryExtensionArgs: async cwd => {
				asked.push(cwd);
				return args;
			},
		});

		create("/w/alpha", "agent", false);
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		for (const options of created) {
			expect((await options.builtinMcp?.())?.args).toEqual([...ALWAYS, "-e", "/ud/ai-memory/omp-ext"]);
			args = [];
			expect((await options.builtinMcp?.())?.args).toEqual(ALWAYS);
			args = ["-e", "/ud/ai-memory/omp-ext"];
		}
		// The extension flags depend on the folder (a project's own disabled list), so each spawn names its own.
		expect(asked).toEqual(Array(asked.length).fill("/w/alpha"));
		expect(asked.length).toBeGreaterThan(0);
	});

	it("hands the hub address and credentials only to spawns that mount memory", async () => {
		let memory: string[] = [];
		const hub = { OMP_GUI_MCP_HUB: "http://127.0.0.1:7", OMP_GUI_MCP_AUTH: "Bearer s" };
		const mcpHubEnv = vi.fn(async () => hub);
		created.length = 0;
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			mcpHubEnv,
			aiMemoryExtensionArgs: async () => memory,
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
		});
		create("/w/alpha", "agent", false);
		const [options] = created;

		const off = await options?.builtinMcp?.();
		expect(off?.args).toEqual(ALWAYS);
		expect(off?.env).not.toHaveProperty("OMP_GUI_MCP_HUB");
		expect(off?.env).not.toHaveProperty("OMP_GUI_MCP_AUTH");
		expect(mcpHubEnv).not.toHaveBeenCalled();
		memory = ["-e", "/ud/ai-memory/omp-ext"];
		expect((await options?.builtinMcp?.())?.env).toMatchObject(hub);
		expect(mcpHubEnv).toHaveBeenCalledTimes(1);
	});

	it("mounts agent-desktop on every tab it spawns, hosted ones included, only while it is picked and present, read per spawn", async () => {
		const tools = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-factory-tools-"));
		const bundle = path.join(tools, "bundle");
		try {
			let pick: unknown;
			const create = localSidecarFactory({
				bridgeDir: "/bridge",
				builtinDir: "/builtin",
				proxyEnv: async () => ({}),
				bridgeHealth: new BridgeHealth(() => {}),
				sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
				replyLanguagePref: () => undefined,
				userProfilePref: () => undefined,
				nextPromptPrefs: () => ({ suggestions: true, inline: true }),
				autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
				judgeAssistPref: () => true,
				delegationPref: () => undefined,
				accountRotationPref: () => undefined,
				accountRotationLedger: "/ledger.json",
				launchFlags: () => [],
				computerUse: { pref: () => pick, toolsDir: tools, bundleDir: bundle, platform: "darwin" },
			});
			created.length = 0;
			create("/w/alpha", "agent", false);
			create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
			const executable = path.join(bundle, "agent-desktop");

			// Picked (the default), with no managed copy and no bundled one (a dev run): nothing mounted, the bridge is told.
			for (const options of created) {
				const missing = await options.builtinMcp?.();
				expect(missing?.args).toEqual(ALWAYS);
				expect(missing?.env).toMatchObject({ OMP_GUI_COMPUTER_USE: "missing" });
				expect(missing?.env).not.toHaveProperty("OMP_GUI_AGENT_DESKTOP");
			}

			fs.mkdirSync(bundle, { recursive: true });
			fs.writeFileSync(executable, "");
			fs.writeFileSync(path.join(bundle, "agent-desktop.build.json"), JSON.stringify({ version: "1.2.0" }));
			for (const options of created) {
				const mounted = await options.builtinMcp?.();
				expect(mounted?.args).toEqual(["-e", path.join("/builtin", "agent-desktop"), ...ALWAYS]);
				expect(mounted?.env).toMatchObject({
					OMP_GUI_COMPUTER_USE: "agent-desktop",
					OMP_GUI_AGENT_DESKTOP: executable,
				});
			}

			pick = "builtin";
			for (const options of created) {
				const builtin = await options.builtinMcp?.();
				expect(builtin?.args).toEqual(ALWAYS);
				expect(builtin?.env).toMatchObject({ OMP_GUI_COMPUTER_USE: "builtin" });
			}
		} finally {
			fs.rmSync(tools, { recursive: true, force: true });
		}
	});

	it("wakes the shared-checkout pass on the bridge's checkout_files frame of any tab, and on no other frame", () => {
		const wakes: string[] = [];
		const create = localSidecarFactory({
			bridgeDir: "/bridge",
			builtinDir: "/builtin",
			proxyEnv: async () => ({}),
			bridgeHealth: new BridgeHealth(() => {}),
			sessionKinds: new SessionKindStore(path.join(os.tmpdir(), "omp-gui-factory-kinds.json")),
			replyLanguagePref: () => undefined,
			userProfilePref: () => undefined,
			nextPromptPrefs: () => ({ suggestions: true, inline: true }),
			autoTitlePrefs: () => ({ enabled: true, evolve: true, suppressed: false }),
			judgeAssistPref: () => true,
			delegationPref: () => undefined,
			accountRotationPref: () => undefined,
			accountRotationLedger: "/ledger.json",
			launchFlags: () => [],
			checkoutFiles: owner => wakes.push(owner === sidecars.at(-1) ? "pass" : "other"),
		});
		const emitFrame = (type: string) => {
			for (const listener of sidecars.at(-1)?.listeners.get("frame") ?? []) listener({ type });
		};
		create("/w/alpha", "agent", false);
		emitFrame("message_update");
		expect(wakes).toEqual([]);
		emitFrame("checkout_files");
		create("/w/alpha", "agent", true, { deviceId: "peer-1", name: "Laptop", hostName: "Desk" });
		emitFrame("checkout_files");
		expect(wakes).toEqual(["pass", "pass"]);
	});
});
