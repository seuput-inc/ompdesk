import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { RpcGetQueueResult } from "../../shared/rpc-types";
import { SidecarManager } from "../sidecar";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";

it("edits the chip the window saw on this spawn, without intercepting direct stock commands", async () => {
	const dir = await mkdtemp(join(tmpdir(), "queue-wire-"));
	const parameters = JSON.parse(`${'{"type":"array","items":'.repeat(160)}{"type":"string"}${"}".repeat(160)}`);
	const sessionFile = join(dir, "named.jsonl");
	const bin = await writeFakeOmp(
		dir,
		`
		import { createInterface } from "node:readline";
		const out = value => console.log(JSON.stringify(value));
		const steering = ["a", "b"];
		const parameters = ${JSON.stringify(parameters)};
		let getStateCalls = 0;
		out({ type: "ready", supportedProtocolVersions: [1] });
		createInterface({ input: process.stdin }).on("line", line => {
			const { id, type, message } = JSON.parse(line);
			let data;
			switch (type) {
				case "get_state":
					getStateCalls++;
					data = { sessionId: "s", sessionFile: ${JSON.stringify(sessionFile)}, sessionName: "Named", dumpTools: [{ parameters }], queuedMessages: { steering, followUp: [] } };
					break;
				case "get_queue": data = { getStateCalls }; break;
				case "remove_queued_message": {
					if (message === "b") {
						out({ type: "response", command: type, id, success: false, code: "stock_refusal", error: "stock refused" });
						return;
					}
					const i = steering.indexOf(message);
					if (i >= 0) steering.splice(i, 1);
					data = { removed: i >= 0 }; break;
				}
				case "steer": steering.push(message); break;
			}
			if (type === "remove_queued_message" || type === "steer") {
				out({ type: "queue_update", steering, followUp: [], extra: parameters });
			}
			out({ type: "response", command: type, id, success: true, data });
		});
	`,
	);
	const sc = new SidecarManager({
		cwd: dir,
		omp: async () => ({
			ok: true,
			runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		}),
	});
	try {
		const ready = Promise.withResolvers<void>();
		const identities: unknown[] = [];
		sc.on("session", identity => identities.push(identity));
		sc.on("status", ({ status }) => {
			if (status === "ready") ready.resolve();
		});
		sc.start();
		await ready.promise;
		const client = sc.rpcClient;
		if (!client) throw new Error("no client");
		const first = await client.command({ type: "get_queue" });
		expect(first).toMatchObject({
			type: "response",
			command: "get_queue",
			id: expect.stringMatching(/^gui-\d+$/),
			success: true,
		});
		const [a, b] = (first.data as RpcGetQueueResult).steering;
		expect(a.id).toMatch(/^q\d+$/);
		expect(a.timestamp).toEqual(expect.any(Number));
		const frames: unknown[] = [];
		sc.on("frame", frame => {
			if (frame.type === "queue_update") frames.push(frame);
		});
		const edited = await client.command({ type: "queue_edit", queueId: a.id, text: "edited" });
		expect(edited).toMatchObject({ success: true, data: { updated: true } });
		expect(frames).toEqual([
			{ type: "queue_update", steering: [b], followUp: [], extra: parameters },
			{ type: "queue_update", steering: [b, { ...a, text: "edited" }], followUp: [], extra: parameters },
		]);
		await expect(client.command({ type: "queue_move", queueId: b.id, toIndex: 1 })).resolves.toMatchObject({
			success: false,
			code: "unsupported",
		});
		// One get_state at ready, one for get_queue. The edit and move need no identity refresh.
		await expect(client.stock({ type: "get_queue" })).resolves.toMatchObject({ data: { getStateCalls: 2 } });
		expect(identities).toEqual([{ sessionId: "s", sessionFile, sessionName: "Named" }]);
		await expect(client.command({ type: "queue_remove", queueId: b.id })).resolves.toEqual({
			type: "response",
			command: "queue_remove",
			id: expect.stringMatching(/^gui-\d+$/),
			success: false,
			error: "stock refused",
		});
		await expect(client.stock({ type: "remove_queued_message", message: "b", queue: "steering" })).resolves.toEqual({
			type: "response",
			command: "remove_queued_message",
			id: expect.any(String),
			success: false,
			code: "stock_refusal",
			error: "stock refused",
		});
		sc.kill();
		await expect(client.command({ type: "queue_remove", queueId: b.id })).resolves.toMatchObject({
			success: false,
			error: "Sidecar disconnected",
		});
	} finally {
		sc.dispose();
		await sc.whenExited();
		await rm(dir, RM_TEMP);
	}
});
