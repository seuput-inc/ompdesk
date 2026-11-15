import { expect, it, vi } from "vitest";
import { installQuitGuard } from "./app-quit";

const electron = vi.hoisted(() => ({
	willQuit: [] as Array<(event: { preventDefault(): void }) => void>,
	exit: vi.fn<(code: number) => void>(),
}));

vi.mock("electron", () => ({
	app: {
		on: (name: string, listener: (event: { preventDefault(): void }) => void) => {
			if (name === "will-quit") electron.willQuit.push(listener);
		},
		quit: vi.fn(),
		exit: electron.exit,
	},
	autoUpdater: { on: () => {} },
	BrowserWindow: { getFocusedWindow: () => null },
	dialog: { showMessageBox: vi.fn() },
}));
vi.mock("./runtime-log", () => ({ writeRuntimeLog: vi.fn() }));
vi.mock("./i18n", () => ({ getMainLanguage: () => "en", mainT: () => "" }));

it("exits with failure when the last core stop cannot establish that its processes ended", async () => {
	const finished = Promise.withResolvers<number>();
	electron.exit.mockImplementation(finished.resolve);
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	installQuitGuard(
		() => [],
		() => {},
		async () => {},
		async () => {
			throw new Error("git processes it started may still run");
		},
	);
	const preventDefault = vi.fn();
	for (const listener of electron.willQuit) listener({ preventDefault });
	expect(preventDefault).toHaveBeenCalledOnce();
	expect(await finished.promise).toBe(1);
	expect(warning).toHaveBeenCalledWith(expect.stringContaining("git processes it started may still run"));
	warning.mockRestore();
});
