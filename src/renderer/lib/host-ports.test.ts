import { afterEach, describe, expect, it, vi } from "vitest";
import { hostPortUrl, hostTabCannotOpen } from "./host-ports";

const globals = globalThis as Record<string, unknown>;

afterEach(() => {
	delete globals.window;
});

describe("a paired host tab's servers in this computer's Preview", () => {
	it("opens the stand-in it was given, and no other address on this computer's loopback", async () => {
		const hostPort = vi.fn(async () => "http://localhost:5173/");
		globals.window = { omp: { preview: { hostPort } } };
		expect(hostTabCannotOpen("http://localhost:5173/")).toBe(true);

		expect(await hostPortUrl("tab-1", 5173)).toBe("http://localhost:5173/");
		expect(hostPort).toHaveBeenCalledWith("tab-1", 5173);
		expect(hostTabCannotOpen("http://localhost:5173/app?x=1")).toBe(false);
		// Another loopback port is this computer's own, not the host tab's.
		expect(hostTabCannotOpen("http://localhost:5174/")).toBe(true);
		expect(hostTabCannotOpen("http://127.0.0.1:3000/")).toBe(true);
		// A web address is not this computer's: the host tab opens it as any page.
		expect(hostTabCannotOpen("https://example.com/")).toBe(false);
	});
});
