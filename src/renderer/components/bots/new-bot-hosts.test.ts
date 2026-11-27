import { describe, expect, it } from "vitest";
import type { HostView } from "../../../shared/ipc-types";
import { botHostRows, failedHostProbe, type HostState } from "./new-bot-hosts";

const local = { name: "Desk", platform: "win32" };
const hosts: HostView[] = [
	{ deviceId: "away", name: "Away", state: "offline" },
	{ deviceId: "old", name: "Old", state: "online" },
	{ deviceId: "studio", name: "Studio", platform: "darwin", state: "online" },
	{ deviceId: "connecting", name: "Laptop", state: "connecting" },
];
const probes = new Map<string, HostState>([
	["", "ready"],
	["studio", "ready"],
	["old", "update"],
	["away", "ready"],
]);

describe("New bot host choices", () => {
	it("puts ready computers first without hiding an unavailable computer", () => {
		expect(botHostRows(local, hosts, probes, false).map(row => [row.device, row.state])).toEqual([
			[null, "ready"],
			["studio", "ready"],
			["away", "offline"],
			["old", "update"],
			["connecting", "busy"],
		]);
	});
	it("offers only the handover origin, including when that computer is gone", () => {
		for (const origin of [null, "studio", "removed"]) {
			const rows = botHostRows(local, hosts, probes, false, origin);
			expect(rows.map(row => row.device)).toEqual([origin]);
			expect(rows[0].state).toBe(origin === "removed" ? "offline" : "ready");
		}
	});
	it("disables every cached destination when the serving computer disconnects", () => {
		expect(botHostRows(local, hosts, probes, true).every(row => row.state === "offline")).toBe(true);
	});
	it("distinguishes unsupported commands from unavailable connections", () => {
		expect(failedHostProbe(new Error("unknown action: createFolder"))).toBe("update");
		expect(failedHostProbe(new Error("device disconnected"))).toBe("offline");
		expect(failedHostProbe(new Error("host timeout"))).toBe("busy");
		expect(failedHostProbe(new Error("no response"))).toBe("busy");
	});
});
