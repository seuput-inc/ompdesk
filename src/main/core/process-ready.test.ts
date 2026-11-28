import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { CoreError, CoreProcess } from "./process";

/**
 * Stand-in core owner socket speaking the `owner.rs` protocol: token line, then `{id, method, params}` lines.
 * Lets tests verify `CoreProcess.waitReady()` without spawning the native Rust binary.
 */
async function mockOwner(
	onStart: (
		params: { generation: number; binary: string },
		reply: (frame: Record<string, unknown>) => void,
		emit: (event: string, data: unknown) => void,
	) => void,
) {
	const dir = mkdtempSync(join(tmpdir(), "omp-owner-ready-"));
	const address =
		process.platform === "win32" ? `\\\\.\\pipe\\ompdesk-owner-ready-${randomUUID()}` : join(dir, "owner.sock");
	const token = "test-owner-token";
	const sockets = new Set<Socket>();
	const server: Server = createServer(socket => {
		sockets.add(socket);
		let authed = false;
		const send = (frame: Record<string, unknown>) => {
			if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
		};
		const emit = (event: string, data: unknown) => send({ event, data });
		createInterface({ input: socket }).on("line", line => {
			if (!authed) {
				if (line === token) authed = true;
				else socket.destroy();
				return;
			}
			const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
			if (request.method === "core.start") {
				onStart(
					request.params as { generation: number; binary: string },
					frame => send({ id: request.id, ...frame }),
					emit,
				);
				return;
			}
			send({ id: request.id, ok: true, result: {} });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		target: { connect: address, token },
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>(resolve => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("CoreProcess.waitReady", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("resolves once the owner answers core.start with ready=true, even after a slow cold start", async () => {
		const owner = await mockOwner((_params, reply) => {
			setTimeout(() => reply({ ok: true, result: { pid: 4242, spawnMs: 120, readyMs: 140, ready: true } }), 120);
		});
		cleanups.push(() => owner.close());
		const proc = new CoreProcess({ binary: () => "/fake/ompdesk-core", log: () => {} });
		proc.ownBy(owner.target);
		const started = performance.now();
		await proc.waitReady(5_000);
		expect(performance.now() - started).toBeGreaterThanOrEqual(100);
		expect(proc.pid).toBe(4242);
		// A second call after ready resolves immediately on the same generation.
		await proc.waitReady(1_000);
		expect(proc.generation).toBe(1);
	});

	it("rejects with core_exited when the owner reports ready=false (exited before announcing ready)", async () => {
		const owner = await mockOwner((params, reply, emit) => {
			reply({ ok: true, result: { pid: 5151, spawnMs: 10, readyMs: 15, ready: false } });
			emit("core.ended", { generation: params.generation, code: 1, signal: null });
			emit("core.gone", { generation: params.generation, empty: true });
		});
		cleanups.push(() => owner.close());
		const proc = new CoreProcess({ binary: () => "/fake/ompdesk-core", log: () => {} });
		proc.ownBy(owner.target);
		await expect(proc.waitReady(2_000)).rejects.toMatchObject({
			code: "core_exited",
		});
	});

	it("rejects with core_unavailable when the owner cannot spawn the binary", async () => {
		const owner = await mockOwner((_params, reply) => {
			reply({ ok: false, error: { code: "failed", message: "ompdesk-core could not run: ENOENT" } });
		});
		cleanups.push(() => owner.close());
		const proc = new CoreProcess({ binary: () => "/missing/ompdesk-core", log: () => {} });
		proc.ownBy(owner.target);
		await expect(proc.waitReady(2_000)).rejects.toMatchObject({
			code: "core_unavailable",
			message: expect.stringContaining("ENOENT"),
		});
	});

	it("rejects with timeout when the owner never announces ready within timeoutMs", async () => {
		const owner = await mockOwner(() => {
			// Intentionally never replies (e.g. hung CreateProcessW / Defender scan past budget).
		});
		cleanups.push(() => owner.close());
		const proc = new CoreProcess({ binary: () => "/hung/ompdesk-core", log: () => {} });
		proc.ownBy(owner.target);
		const error = await proc.waitReady(80).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(CoreError);
		expect((error as CoreError).code).toBe("timeout");
	});
});
