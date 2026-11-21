import { spawn } from "node:child_process";
import { once } from "node:events";
import * as os from "node:os";
import { expect, it } from "vitest";
import { lowerAgentPriority } from "./agent-priority";

it("lowers a Node-spawned child's priority without changing its parent's", async () => {
	const before = os.getPriority();
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	const closed = once(child, "close");
	try {
		await once(child, "spawn");
		if (!child.pid) throw new Error("no child pid");
		lowerAgentPriority(child.pid);
		expect(os.getPriority(child.pid)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
		expect(os.getPriority()).toBe(before);
	} finally {
		child.stdin.end();
		await closed;
	}
});
