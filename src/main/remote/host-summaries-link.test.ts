/**
 * A paired device's copy of a host's session summaries follows the host's run state end to end: a real host
 * (`LocalHostServices` and its one `SessionSummaries` builder, wired as `index.ts` wires them, over a real
 * `SidecarManager` running the scripted omp) and a real device (`RemoteDevices`) over a real link. What the device's
 * sidebar and `ompdesk_sessions` read of the host (`RemoteDevices.summaries`) must equal what the host builds, as its
 * session goes idle → running → idle, and again across a link that drops and comes back mid-turn.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../shared/session-summary";
import { closeSessions, openSession, type Session } from "./link-traffic-test-rig";
import { until } from "./test-devices";

afterEach(closeSessions);

const WAIT = { timeout: 15_000, interval: 20 };

/**
 * The device's copy reaches `status` by what the host pushes by itself (`current()` would publish a pending change
 * for it, so the wait never calls it); only then is the copy held to the host's whole set.
 */
async function deviceShows(session: Session, status: SessionSummary["status"]): Promise<void> {
	const host = session.hostSummaries;
	if (!host) throw new Error("expected the host's summaries");
	await vi.waitFor(
		() => expect(session.device.devices.summaries(session.hostId)?.sessions).toMatchObject([{ status }]),
		WAIT,
	);
	const built = host.current();
	expect(built.sessions).toMatchObject([{ status }]);
	await vi.waitFor(() => expect(session.device.devices.summaries(session.hostId)).toEqual(built), WAIT);
}

describe("a host's run state on a paired device", () => {
	it("follows the host's session idle → running → idle, and across a link that drops mid-turn", async () => {
		const session = await openSession({ summaries: true });
		await deviceShows(session, "ready");
		expect(session.device.devices.summaries(session.hostId)?.sessions[0]).toMatchObject({
			openFor: "Laptop",
			kind: "agent",
		});

		// A turn whose tool call says nothing for a while (a CI wait): the host's row runs, so the device's does.
		const first = session.turn({ kind: "tool-wait", seconds: 2 });
		await deviceShows(session, "running");
		await first;
		await deviceShows(session, "ready");

		// The next turn is still running when the device's link to the host drops and comes back (Connect pressed again:
		// the old link ends and a new one carries the host's open tabs). Turning sharing off would close the host's tabs.
		const prompt = session.sidecar.rpcClient?.command({
			type: "prompt",
			message: JSON.stringify({ kind: "tool-wait", seconds: 8 }),
		});
		await deviceShows(session, "running");
		await session.device.devices.connect("nSTUDIO");
		await until(session.device, state => state.hosts[0]?.state === "online");
		await deviceShows(session, "running");
		await prompt;
		await deviceShows(session, "ready");
	}, 60_000);
});
