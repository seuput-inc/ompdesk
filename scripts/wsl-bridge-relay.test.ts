import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	chownSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmdirSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../resources/gui-bridge/wsl/bridge-relay.ts", import.meta.url));
const uid = process.getuid?.();
const runtime = `/run/user/${uid}`;
const app = `${runtime}/ompdesk`;
const options = { env: { PATH: process.env.PATH }, timeout: 3_000, killSignal: "SIGKILL" as const };

// Use the actual per-user runtime, never redirect a production socket lookup through a test-only switch.
describe.skipIf(process.platform !== "linux" || !existsSync(runtime))("guest bridge relay", () => {
	let madeApp = false;
	let id: string;
	let dir: string;
	let path: string;
	let server: Server;
	const peers = new Set<Socket>();

	beforeAll(() => {
		const home = lstatSync(runtime);
		expect([home.isDirectory(), home.uid, home.mode & 0o777]).toEqual([true, uid, 0o700]);
		madeApp = mkdirSync(app, { recursive: true, mode: 0o700 }) !== undefined;
		const parent = lstatSync(app);
		expect([parent.isDirectory(), parent.uid, parent.mode & 0o777]).toEqual([true, uid, 0o700]);
	});
	afterAll(() => {
		if (!madeApp) return;
		try {
			rmdirSync(app);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
		}
	});
	beforeEach(async () => {
		id = randomBytes(16).toString("hex");
		dir = `${app}/${id}`;
		path = `${dir}/bridge.sock`;
		mkdirSync(dir, { mode: 0o700 });
		server = createServer({ allowHalfOpen: true }, peer => peers.add(peer));
		server.listen(path);
		await once(server, "listening");
	});
	async function closeServer() {
		const closed = once(server, "close");
		server.close();
		await closed;
	}
	afterEach(async () => {
		for (const peer of peers) peer.destroy();
		peers.clear();
		if (server.listening) await closeServer();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the ready line before binary data in both directions and exits on peer EOF with stdin open", async () => {
		const request = randomBytes(512 * 1024);
		const reply = randomBytes(512 * 1024);
		const greeting = Buffer.from([0, 255, 10]);
		const received: Buffer[] = [];
		server.once("connection", (peer: Socket) => {
			peer.write(greeting);
			let length = 0;
			peer.on("data", (bytes: Buffer) => {
				received.push(bytes);
				length += bytes.length;
				if (length >= request.length) peer.end(reply);
			});
		});
		const child = spawn("bun", [script, id], options);
		const exit = once(child, "close");
		const output = buffer(child.stdout);
		child.stdin.write(request);
		expect(await exit).toEqual([0, null]);
		expect(Buffer.concat(received).equals(request)).toBe(true);
		expect((await output).equals(Buffer.concat([Buffer.from("OK\n"), greeting, reply]))).toBe(true);
	});

	it("flushes stdin and exits on host EOF without waiting for a reply", async () => {
		const request = randomBytes(128 * 1024);
		const input = once(server, "connection").then(([peer]) => buffer(peer));
		const child = spawn("bun", [script, id], options);
		const exit = once(child, "close");
		const output = buffer(child.stdout);
		child.stdin.end(request);
		expect(await exit).toEqual([0, null]);
		expect((await input).equals(request)).toBe(true);
		expect((await output).toString()).toBe("OK\n");
	});

	function expectRefusal(...args: string[]) {
		const result = spawnSync("bun", [script, ...args], options);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stdout.length).toBe(0);
	}

	it("rejects noncanonical paths and extra arguments even when they name this live socket", () => {
		expectRefusal(`../${id}`);
		expectRefusal(id, path);
	});
	it("rejects a group-accessible spawn directory", () => {
		chmodSync(dir, 0o750);
		expectRefusal(id);
	});
	it("rejects a symlink even when its target is a live socket", () => {
		renameSync(path, `${path}.real`);
		symlinkSync(`${path}.real`, path);
		expectRefusal(id);
	});
	it.skipIf(uid !== 0)("rejects a socket owned by a different uid", () => {
		chownSync(path, 65534, 65534);
		expectRefusal(id);
	});
	it("does not announce success for a socket inode with no listener", async () => {
		renameSync(path, `${path}.stale`);
		await closeServer();
		renameSync(`${path}.stale`, path);
		expectRefusal(id);
	});
});
