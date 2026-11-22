import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	CreditSpendRefusal,
	creditSpendRun,
	type OmpLaunch,
	ompArgs,
	SESSION_OWNED_ENV,
	type SessionOpen,
	sessionEnv,
	sessionOpen,
	withCreditSpendRuns,
	withoutSessionEnv,
} from "./omp-launch";

/** A launch with every extension, setting and origin there is. */
const FULL: OmpLaunch = {
	open: "new",
	bridge: { dir: "/bridge", address: "/tmp/omp-gui-1.sock" },
	builtin: {
		args: ["-e", "/builtin", "-e", "/builtin/rea"],
		root: "/builtin/rea",
		// sidecar-factory.ts `builtinMcp` with every pack and memory on, agent-desktop mounted, and the MCP hub's address.
		env: {
			OMP_GUI_PSTACK: "1",
			OMP_GUI_ECC: "1",
			PONYTAIL_DEFAULT_MODE: "full",
			OMP_GUI_COMPUTER_USE: "agent-desktop",
			OMP_GUI_AGENT_DESKTOP: "/tools/agent-desktop/agent-desktop",
			OMP_GUI_MEMORY: "/ud/recall.json",
			OMP_GUI_MCP_HUB: "http://127.0.0.1:4100",
			OMP_GUI_MCP_AUTH: "Bearer s",
			OMP_GUI_MCP_CWD: "%2Fw",
		},
	},
	userFlags: [],
	settings: {
		replyLanguage: "Korean",
		userProfile: { name: "Seu", experience: "expert" },
		nextPrompt: { suggestions: true, inline: true },
		autoTitle: { enabled: true, evolve: true, suppressed: false },
		judgeAssist: false,
		delegation: "swarm",
		accountRotation: "even",
		accountRotationLedger: "/ud/rotation.json",
		creditSpend: false,
		ompdeskRolesFile: "/ud/roles.json",
		browser: { kind: "ego" },
	},
	origin: { deviceId: "phone", name: "Phone", hostName: "Desk" },
	processTag: "0123456789abcdef0123456789abcdef",
	scratchDir: "/home/seu/.cache/ompdesk/scratch/0123456789abcdef0123456789abcdef",
	keepCli: "/Applications/OMPdesk.app/Contents/Resources/ompdesk-bin/ompdesk",
};

describe("omp launch", () => {
	// A variable a spawn sets but never strips from what it inherits leaks one OMPdesk session's plumbing (its bridge
	// socket, delegation, memory file) into a tab started from that session's shell; a stale entry hides a removed one.
	it("strips exactly the variables a spawn sets for its session from what it inherits", () => {
		expect(Object.keys(sessionEnv(FULL)).sort()).toEqual([...SESSION_OWNED_ENV].sort());
		const inherited = { ...sessionEnv(FULL), PATH: "/bin", HOME: "/home/seu" };
		expect(withoutSessionEnv(inherited)).toEqual({ PATH: "/bin", HOME: "/home/seu" });
	});

	it("leaves out each setting at its default", () => {
		const bare: OmpLaunch = { open: "default", builtin: { args: [] }, userFlags: [], settings: {} };
		expect(sessionEnv(bare)).toEqual({});
		expect(
			sessionEnv({ ...bare, settings: { delegation: "default", userProfile: { name: "", experience: null } } }),
		).toEqual({});
		expect(ompArgs(bare)).toEqual(["--mode", "rpc-ui"]);
	});

	it("passes the credit-use switch both ways, so an omp never falls back to a default the person did not pick", () => {
		const bare: OmpLaunch = { open: "default", builtin: { args: [] }, userFlags: [], settings: {} };
		expect(sessionEnv({ ...bare, settings: { creditSpend: false } })).toEqual({ OMP_GUI_CREDIT_SPEND: "0" });
		expect(sessionEnv({ ...bare, settings: { creditSpend: true } })).toEqual({ OMP_GUI_CREDIT_SPEND: "1" });
	});

	const recorded = () => {
		const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
		const runtime = {
			bin: "/bin/omp",
			version: "19.0.0",
			run: async (args: string[], opts?: { env?: Record<string, string> }) => {
				calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
				return { code: 0, stdout: "", stderr: "" };
			},
		};
		return { calls, runtime };
	};

	it("gives an `omp -p` run beside the sessions the credit-use extension and the switch, and no other omp command", async () => {
		const { calls, runtime } = recorded();
		let enabled = false;
		const commitCheck = vi.fn(async () => ({}));
		const omp = withCreditSpendRuns(runtime, { bridgeDir: "/bridge", enabled: () => enabled, commitCheck });
		await omp.run(["-p", "--no-session"], { env: { PI_NOTIFICATIONS: "off" } });
		// The switch is read at each run, as the person left it.
		enabled = true;
		await omp.run(["-p"]);
		await omp.run(["commit", "--dry-run"], { env: { A: "1" } });
		await omp.run(["plugin", "list"]);
		const entry = ["-e", join("/bridge", "credit-spend-run.ts")];
		expect(calls).toEqual([
			{ args: ["-p", "--no-session", ...entry], env: { PI_NOTIFICATIONS: "off", OMP_GUI_CREDIT_SPEND: "0" } },
			{ args: ["-p", ...entry], env: { OMP_GUI_CREDIT_SPEND: "1" } },
			{ args: ["commit", "--dry-run"], env: { A: "1" } },
			{ args: ["plugin", "list"] },
		]);
		expect(creditSpendRun("/bridge", false)).toEqual({ args: entry, env: { OMP_GUI_CREDIT_SPEND: "0" } });
		// On: `omp commit` runs as stock does, unasked.
		expect(commitCheck).not.toHaveBeenCalled();
	});

	it("with the switch off runs `omp commit` only after the tab's omp checked the plan, and never past a refusal or a check that could not run", async () => {
		const refusal =
			"usage_limit_reached: this ChatGPT account reached its plan's usage limit, which resets in about 3 hours, and OMPdesk's Credit use setting is off, so it does not run on credits. retry-after-ms=10800000";
		const answers: Array<() => Promise<unknown>> = [
			async () => ({}),
			async () => {
				throw new Error(refusal);
			},
			async () => {
				throw new Error("Unknown bridge method: credit_spend_commit_check");
			},
		];
		const { calls, runtime } = recorded();
		const commitCheck = vi.fn(() => (answers.shift() ?? (async () => ({})))());
		const omp = withCreditSpendRuns(runtime, { bridgeDir: "/bridge", enabled: () => false, commitCheck });
		await omp.run(["commit", "--dry-run"]);
		expect(calls).toEqual([{ args: ["commit", "--dry-run"] }]);
		const refused = await omp.run(["commit", "--dry-run"]).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(CreditSpendRefusal);
		expect((refused as Error).message).toBe(
			"Commit message not generated: this ChatGPT account reached its plan's usage limit, which resets in about 3 hours, and OMPdesk's Credit use setting is off, so it does not run on credits.",
		);
		const unchecked = await omp.run(["commit", "--dry-run"]).catch((error: unknown) => error);
		expect(unchecked).toBeInstanceOf(CreditSpendRefusal);
		expect((unchecked as Error).message).toMatch(
			/could not check the account's plan first\. Write the message yourself/,
		);
		// Neither refused press started omp.
		expect(calls).toHaveLength(1);
		expect(commitCheck).toHaveBeenCalledTimes(3);
	});

	it("opens a tab's session by the one rule, for every combination of what the tab knows", () => {
		const written = new Set(["/s/written.jsonl"]);
		for (const path of [null, "/s/written.jsonl", "/s/unwritten.jsonl"]) {
			for (const isNew of [false, true]) {
				const open: SessionOpen = sessionOpen({ path, isNew }, file => written.has(file));
				// A written session is always reopened.
				if (path && written.has(path)) expect(open).toEqual({ session: path });
				// `--session` never names a file stock never wrote ("Session not found").
				else expect(open).not.toHaveProperty("session");
				// A new tab, or one whose session stock has not written yet, never lets autoResume pick another session.
				if (isNew || path) expect(open).not.toBe("default");
			}
		}
	});
});
