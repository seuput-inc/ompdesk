import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebPairingRequest } from "../../shared/mobile-web";
import { DEFAULT_WEB_GRANTS } from "../../shared/web-protocol";
import { core } from "../core/process";
import { advanceCoreTimers, fakeCoreTimers, realCoreTimers } from "../core/test-clock";
import { PAIRING_CONFIRM_TIMEOUT_MS, PairingConfirmations } from "./pairing";

describe("PairingConfirmations", () => {
	beforeEach(() => fakeCoreTimers());
	afterEach(realCoreTimers);

	const details = { name: "iPhone", userAgent: "UA", tailscaleLogin: "me@example.com", ip: "100.64.0.2" };

	let nextHost = 0;
	function rig() {
		const shown: WebPairingRequest[] = [];
		const host = ++nextHost;
		return { host, shown, confirmations: new PairingConfirmations(host, { notify: request => shown.push(request) }) };
	}

	it("shows the desktop the phone's details and the default tier, and settles with its approval", async () => {
		const { shown, confirmations } = rig();
		const outcome = confirmations.request(details);
		expect(shown).toHaveLength(1);
		expect(shown[0]).toMatchObject({ ...details, grants: [...DEFAULT_WEB_GRANTS] });
		expect(await confirmations.pending()).toEqual(shown);
		expect(
			await confirmations.respond({ id: shown[0]?.id ?? "", approve: true, grants: ["workspace", "pairing-admin"] }),
		).toBe(true);
		await expect(outcome).resolves.toEqual({ approved: true, grants: ["workspace"] });
		expect(await confirmations.pending()).toEqual([]);
		expect(await confirmations.respond({ id: shown[0]?.id ?? "", approve: true })).toBe(false);
	});

	it("keeps the first desktop's refusal when another desktop immediately approves", async () => {
		const { shown, confirmations } = rig();
		const outcome = confirmations.request(details);
		const id = shown[0]?.id ?? "";
		const first = confirmations.respond({ id, approve: false });
		const second = confirmations.respond({ id, approve: true });
		await expect(Promise.all([first, second])).resolves.toEqual([true, false]);
		await expect(outcome).resolves.toEqual({ approved: false, reason: "declined" });
	});

	it("times out after 60 s", async () => {
		const { shown, confirmations } = rig();
		const outcome = confirmations.request(details);
		await advanceCoreTimers(PAIRING_CONFIRM_TIMEOUT_MS - 1);
		expect(await confirmations.pending()).toHaveLength(1);
		await advanceCoreTimers(1);
		await expect(outcome).resolves.toEqual({ approved: false, reason: "timeout" });
		expect(await confirmations.pending()).toEqual([]);
		expect(await confirmations.respond({ id: shown[0]?.id ?? "", approve: true })).toBe(false);
	});

	it("declines this host's waiting phones and computers without affecting another host", async () => {
		const { host, confirmations } = rig();
		const other = rig();
		const outcomes = [confirmations.request(details), confirmations.request({ ...details, kind: "computer" })];
		const separate = other.confirmations.request(details);
		const foreign = other.shown[0]?.id ?? "";
		const waiting = confirmations.pending();
		const stopped = core().call("web.stop", { host });
		expect((await waiting).map(request => request.kind)).toEqual([undefined, "computer"]);
		await stopped;
		expect(await confirmations.respond({ id: foreign, approve: true })).toBe(false);
		expect(await other.confirmations.pending()).toEqual(other.shown);
		await other.confirmations.respond({ id: foreign, approve: true, grants: [] });
		await expect(separate).resolves.toEqual({ approved: true, grants: [] });
		await expect(Promise.all(outcomes)).resolves.toEqual([
			{ approved: false, reason: "declined" },
			{ approved: false, reason: "declined" },
		]);
	});
});
