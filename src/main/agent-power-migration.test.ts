// The one-time "every agent power on" migration, run by the core (crates/core/src/prefs/powers.rs) on a real prefs
// file: what a launch's `prefsStore()` sees, read the way each consumer resolves its switch.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	AGENT_CONTROL_APPROVE_PREF,
	AGENT_CONTROL_FULL_PREF,
	AGENT_CONTROL_MANAGE_PREF,
	AGENT_CONTROL_PREF,
	agentControlApproveEnabled,
	agentControlEnabled,
	agentControlFullEnabled,
	agentControlManageEnabled,
} from "../shared/agent-control";
import { ECC_PREF, eccEnabled } from "../shared/ecc";
import { PSTACK_PREF, pstackEnabled } from "../shared/pstack";
import { stopCore } from "./core/process";
import { PrefsStore } from "./prefs-store";

const root = mkdtempSync(join(tmpdir(), "ompdesk-powers-"));
let count = 0;

afterAll(async () => {
	await stopCore();
	rmSync(root, { recursive: true, force: true });
});

/** A profile with `prefs` stored, and its agent folder. */
function profile(prefs: Record<string, unknown> = {}): { store: PrefsStore; agentDir: string } {
	const dir = join(root, String(++count));
	const agentDir = join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(dir, "prefs.json"), JSON.stringify(prefs));
	return { store: new PrefsStore(join(dir, "prefs.json")), agentDir };
}

function resolved(store: PrefsStore) {
	return {
		control: agentControlEnabled(store.get(AGENT_CONTROL_PREF)),
		full: agentControlFullEnabled(store.get(AGENT_CONTROL_FULL_PREF)),
		manage: agentControlManageEnabled(store.get(AGENT_CONTROL_MANAGE_PREF)),
		approve: agentControlApproveEnabled(store.get(AGENT_CONTROL_APPROVE_PREF)),
		pstack: pstackEnabled(store.get(PSTACK_PREF)),
		ecc: eccEnabled(store.get(ECC_PREF)),
	};
}

const ALL_ON = { control: true, full: true, manage: true, approve: true, pstack: true, ecc: true };

describe("the agent-power migration", () => {
	it("turns every old explicit off back on once, and a later off stays off", () => {
		const { store, agentDir } = profile({
			[AGENT_CONTROL_PREF]: false,
			[AGENT_CONTROL_FULL_PREF]: false,
			[AGENT_CONTROL_MANAGE_PREF]: false,
			[AGENT_CONTROL_APPROVE_PREF]: false,
			[PSTACK_PREF]: false,
			[ECC_PREF]: false,
			language: "ko",
		});
		// A read before the migration is answered from the core; the migration must not leave it stale.
		expect(resolved(store).pstack).toBe(false);
		expect(store.migrateAgentPowers(agentDir)?.prefs).toHaveLength(6);
		expect(resolved(store)).toEqual(ALL_ON);
		expect(store.get("language")).toBe("ko");

		store.set(AGENT_CONTROL_FULL_PREF, false);
		store.set(PSTACK_PREF, false);
		expect(store.migrateAgentPowers(agentDir)).toBeNull();
		expect(resolved(store)).toMatchObject({ full: false, pstack: false, control: true });
	});

	it("removes an off computer setting and a stricter approval mode from config.yml, keeping comments and the rest", () => {
		const { store, agentDir } = profile();
		const file = join(agentDir, "config.yml");
		writeFileSync(
			file,
			"theme: dark # mine\ncomputer:\n  enabled: false\ntools:\n  approvalMode: always-ask\n  approval:\n    bash: prompt\n",
		);
		expect(store.migrateAgentPowers(agentDir)).toEqual({
			prefs: [],
			stock: ["computer.enabled", "tools.approvalMode"],
		});
		expect(readFileSync(file, "utf8")).toBe("theme: dark # mine\ntools:\n  approval:\n    bash: prompt\n");
		expect(resolved(store)).toEqual(ALL_ON);
	});

	it("still migrates the prefs when config.yml is not valid YAML, and reports why", () => {
		const { store, agentDir } = profile({ [PSTACK_PREF]: false });
		writeFileSync(join(agentDir, "config.yml"), "a: [unclosed\n");
		const report = store.migrateAgentPowers(agentDir);
		expect(report?.prefs).toEqual([PSTACK_PREF]);
		expect(report?.error).toContain("config.yml is not valid YAML");
		expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe("a: [unclosed\n");
		expect(store.migrateAgentPowers(agentDir)).toBeNull();
	});
});
