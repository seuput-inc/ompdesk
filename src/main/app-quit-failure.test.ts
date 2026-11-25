import { expect, it, vi } from "vitest";
import { installQuitGuard } from "./app-quit";
import type { QuitEffects } from "./shell-host/electron/app";

const electron = vi.hoisted(() => ({ effects: null as QuitEffects | null, exit: vi.fn<(code: number) => void>() }));

vi.mock("electron", () => ({
	app: {
		on: () => {},
		quit: vi.fn(),
		exit: electron.exit,
		setQuitEffects: (effects: QuitEffects) => {
			electron.effects = effects;
		},
	},
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: vi.fn() },
}));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: vi.fn() }));
vi.mock("./i18n", () => ({ getMainLanguage: () => "en", mainT: () => "" }));

it("settles with failure when the last core stop cannot establish that its processes ended", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	installQuitGuard(
		() => [],
		() => {},
		async () => {},
		async () => {
			throw new Error("git processes it started may still run");
		},
	);
	expect(await electron.effects?.settle()).toBe(1);
	expect(electron.exit).not.toHaveBeenCalled();
	expect(warning).toHaveBeenCalledWith(expect.stringContaining("git processes it started may still run"));
	warning.mockRestore();
});
