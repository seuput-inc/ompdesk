import { userInfo } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { wslAdmission } from "../resources/gui-bridge/wsl/admission";

const linuxUser = process.platform === "linux" && Boolean(process.getuid?.());
function fixture() {
	const model = { provider: "test", id: "chosen" };
	return {
		model,
		getAvailableModels: () => [model],
		modelRegistry: { authStorage: { keys: { source: () => ({ kind: "oauth" }), keyless: () => false } } },
		sessionManager: { ensureOnDisk: vi.fn(), flush: vi.fn() },
	};
}

it.skipIf(linuxUser)("refuses a host or root process without touching the journal", async () => {
	const session = fixture();
	await expect(wslAdmission(session)).rejects.toThrow("non-root Linux guest");
	expect(session.sessionManager.ensureOnDisk).not.toHaveBeenCalled();
});

describe.skipIf(!linuxUser)("guest admission", () => {
	it("reports only the guest home and eligibility after stock has flushed the journal", async () => {
		const session = fixture();
		const { promise, resolve } = Promise.withResolvers<void>();
		session.sessionManager.flush.mockReturnValue(promise);
		const admitted = wslAdmission(session);
		await Promise.resolve();
		expect(session.sessionManager.ensureOnDisk).toHaveBeenCalledOnce();
		expect(session.sessionManager.flush).toHaveBeenCalledOnce();
		resolve();
		await expect(admitted).resolves.toEqual({ available: true, home: userInfo().homedir });
	});

	it("a catalog model or a keyless marker is not a guest login", async () => {
		const session = fixture();
		const keys = session.modelRegistry.authStorage.keys;
		keys.source = () => ({ kind: "env" });
		expect((await wslAdmission(session)).available).toBe(false);
		keys.source = () => ({ kind: "api_key" });
		keys.keyless = () => true;
		expect((await wslAdmission(session)).available).toBe(false);
		expect(session.sessionManager.ensureOnDisk).not.toHaveBeenCalled();
	});
	it("does not admit a changed selection or a model not offered with guest auth", async () => {
		const session = fixture();
		session.sessionManager.flush.mockImplementation(() => {
			session.model = { provider: "other", id: "different" };
		});
		expect((await wslAdmission(session)).available).toBe(false);
		session.sessionManager.ensureOnDisk.mockClear();
		expect((await wslAdmission(session)).available).toBe(false);
		expect(session.sessionManager.ensureOnDisk).not.toHaveBeenCalled();
	});

	it("propagates a failed journal flush rather than releasing user input", async () => {
		const session = fixture();
		session.sessionManager.flush.mockRejectedValue(new Error("disk full"));
		await expect(wslAdmission(session)).rejects.toThrow("disk full");
	});
});
