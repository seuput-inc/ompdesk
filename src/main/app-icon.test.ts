import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepareShellPolicyFixture, type ShellPolicyFixture, shellPolicyFixture } from "./shell-policy-test-rig";

let fixture: ShellPolicyFixture;
beforeAll(prepareShellPolicyFixture, 180_000);
beforeAll(async () => {
	fixture = await shellPolicyFixture();
});
afterAll(async () => {
	await fixture?.close();
});

const resources = join("installation", "resources");
const rendererRoot = join("pinned", "out", "renderer");

function appIcon(packaged: boolean, windows: boolean, headless?: string) {
	return fixture.call("appIcon", { resources, rendererRoot, packaged, windows, headless });
}

describe("the shell's app icon", () => {
	it("uses the packaged resource and defaults Windows toasts to it", async () => {
		expect(await appIcon(true, true)).toEqual({ path: join(resources, "app-icon.png"), notifications: "appIcon" });
	});

	it("uses the running dev bundle's icon and leaves the system toast icon alone off Windows", async () => {
		expect(await appIcon(false, false, "0")).toEqual({
			path: join("pinned", "resources", "brand", "app-icon.png"),
			notifications: "systemIcon",
		});
	});

	it.each([true, false])("suppresses headless notifications regardless of the OS (Windows: %s)", async windows => {
		expect(await appIcon(false, windows, "1")).toEqual({
			path: join("pinned", "resources", "brand", "app-icon.png"),
			notifications: "off",
		});
	});
});
