import { describe, expect, it } from "vitest";
import { retryingRename } from "../../resources/gui-bridge/extensions/mcp-config-rename";

const held = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

/** A rename the target refuses `refusals` times, then takes; what was tried and slept is recorded. */
function world(refusals: number, error: () => Error = held) {
	const tried: string[] = [];
	const slept: number[] = [];
	let left = refusals;
	const rename = async (_from: unknown, to: unknown) => {
		tried.push(String(to));
		if (left-- > 0) throw error();
	};
	const sleep = async (ms: number) => {
		slept.push(ms);
	};
	return { tried, slept, rename, sleep };
}

describe("stock's MCP config rename on Windows", () => {
	it("lands once the held mcp.json lets go, and gives up with the refusal after about 5 s", async () => {
		const brief = world(2);
		await retryingRename(brief.rename, "win32", brief.sleep)("C:/a/mcp.json.1.tmp", "C:/a/mcp.json");
		expect(brief.tried).toHaveLength(3);
		expect(brief.slept).toEqual([20, 40]);

		const stuck = world(Number.POSITIVE_INFINITY);
		await expect(
			retryingRename(stuck.rename, "win32", stuck.sleep)("C:/p/.mcp.json.1.tmp", "C:/p/.mcp.json"),
		).rejects.toMatchObject({ code: "EPERM" });
		expect(stuck.slept.reduce((sum, ms) => sum + ms, 0)).toBe(5_100);
	});

	it("never retries another file, another platform or another error", async () => {
		const other = world(1);
		await expect(retryingRename(other.rename, "win32", other.sleep)("x.tmp", "C:/a/config.yml")).rejects.toThrow();
		const mac = world(1);
		await expect(retryingRename(mac.rename, "darwin", mac.sleep)("x.tmp", "/a/mcp.json")).rejects.toThrow();
		const missing = world(1, () => Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
		await expect(retryingRename(missing.rename, "win32", missing.sleep)("x.tmp", "C:/a/mcp.json")).rejects.toThrow();
		expect([other.tried.length, mac.tried.length, missing.tried.length]).toEqual([1, 1, 1]);
	});
});
