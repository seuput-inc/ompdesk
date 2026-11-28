import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { sendCheckpoint } from "../resources/gui-bridge/wsl/checkpoint";

const request = {
	sessionKey: "a".repeat(32),
	spawnId: "b".repeat(32),
	basename: "synthetic-session.jsonl",
	stockId: "synthetic:대화-42",
};
const line = (record: object) => `${JSON.stringify(record)}\n`;
function title(text: string) {
	const row = { type: "title", v: 1, title: text, source: "user", pad: "" };
	row.pad = " ".repeat(2048 - Buffer.byteLength(line(row)));
	return line(row);
}
const session = line({ type: "session", id: request.stockId, cwd: "/fixture" });
const message = line({ type: "message", content: "대화" });
const complete = Buffer.from(title("alpha") + session + message);
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(data: Buffer | string = complete) {
	const home = mkdtempSync(join(tmpdir(), "omp-wsl-checkpoint-"));
	homes.push(home);
	const dir = join(home, ".ompdesk-sessions", request.sessionKey);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, request.basename);
	writeFileSync(path, data, { mode: 0o600 });
	const { dev, ino } = statSync(path, { bigint: true });
	return { home, path, source: `${dev}:${ino}` };
}

function checkFrame(wire: Buffer, body: Buffer, source: string, sealed: boolean) {
	const start = wire.indexOf(10) + 1;
	expect(start).toBeGreaterThan(0);
	expect(start).toBeLessThanOrEqual(4096);
	const { sessionKey, spawnId, stockId } = request;
	expect(JSON.parse(wire.subarray(0, start).toString())).toEqual({
		v: 1,
		sessionKey,
		spawnId,
		stockId,
		bytes: body.length,
		source,
	});
	expect(wire.subarray(start, start + body.length)).toEqual(body);
	const tail = wire.subarray(start + body.length);
	if (sealed) {
		expect(tail.length).toBeLessThanOrEqual(4096);
		expect(tail.indexOf(10)).toBe(tail.length - 1);
		expect(JSON.parse(tail.toString())).toEqual({ sha256: createHash("sha256").update(body).digest("hex") });
	} else expect(tail.length).toBe(0);
}

function rewriteTitle(path: string) {
	const fd = openSync(path, "r+");
	try {
		writeSync(fd, Buffer.from(title("omega")), 0, 2048, 0);
	} finally {
		closeSync(fd);
	}
}

describe.skipIf(process.platform !== "linux")("guest checkpoint", () => {
	it("streams the bare stock header and only complete JSONL bytes through Bun stdout", () => {
		const body = Buffer.from(session + message);
		const f = fixture(Buffer.concat([body, Buffer.from('{"unfinished":"'), Buffer.from([0xed, 0x95])]));
		const { sessionKey, spawnId, basename, stockId } = request;
		const cli = join(__dirname, "../resources/gui-bridge/wsl/checkpoint.ts");
		const result = spawnSync("bun", ["--no-env-file", cli, sessionKey, spawnId, basename, stockId], {
			cwd: f.home,
			env: { HOME: f.home, PATH: process.env.PATH },
			timeout: 5000,
		});
		if (result.error) throw result.error;
		expect(result.stderr.toString()).toBe("");
		expect(result.status).toBe(0);
		checkFrame(result.stdout, body, f.source, true);
	});

	it("leaves an append and the completion of a partial line for the next checkpoint", async () => {
		const partial = `{"text":"${"x".repeat(160 * 1024)}`;
		const f = fixture(Buffer.concat([complete, Buffer.from(partial)]));
		const chunks: Buffer[] = [];
		await sendCheckpoint(f.home, request, chunk => {
			if (!chunks.length) appendFileSync(f.path, `"}\n${message}`);
			chunks.push(Buffer.from(chunk));
		});
		checkFrame(Buffer.concat(chunks), complete, f.source, true);
		chunks.length = 0;
		await sendCheckpoint(f.home, request, chunk => {
			chunks.push(Buffer.from(chunk));
		});
		const next = Buffer.concat([complete, Buffer.from(`${partial}"}\n${message}`)]);
		checkFrame(Buffer.concat(chunks), next, f.source, true);
	});

	it.each([
		["same-inode title rewrite", rewriteTitle],
		[
			"same-inode rewrite followed by an append",
			(path: string) => {
				rewriteTitle(path);
				appendFileSync(path, message);
			},
		],
		[
			"byte-identical replacement",
			(path: string) => {
				writeFileSync(`${path}.new`, complete, { mode: 0o600 });
				renameSync(`${path}.new`, path);
			},
		],
		["truncation", (path: string) => truncateSync(path, 1)],
		["unlink", unlinkSync],
	] as const)("omits the seal on %s after delivery of the body", async (_label, mutate) => {
		const f = fixture();
		const chunks: Buffer[] = [];
		let bodyBytes = 0;
		const sending = sendCheckpoint(f.home, request, chunk => {
			if (chunks.length) bodyBytes += chunk.length;
			if (bodyBytes === complete.length) mutate(f.path);
			chunks.push(Buffer.from(chunk));
		});
		await expect(sending).rejects.toThrow();
		checkFrame(Buffer.concat(chunks), complete, f.source, false);
	});

	it("refuses a prefix rewritten and extended before the first payload write", async () => {
		const f = fixture();
		const chunks: Buffer[] = [];
		const sending = sendCheckpoint(f.home, request, chunk => {
			if (!chunks.length) {
				rewriteTitle(f.path);
				appendFileSync(f.path, message);
			}
			chunks.push(Buffer.from(chunk));
		});
		await expect(sending).rejects.toThrow();
		const wire = Buffer.concat(chunks);
		const start = wire.indexOf(10) + 1;
		expect(start).toBeGreaterThan(0);
		expect(wire.length - start).toBeLessThanOrEqual(complete.length);
	});

	it("rejects an unbound stock header, non-basename, invalid IDs and oversized snapshot before output", async () => {
		const f = fixture();
		const chunks: Buffer[] = [];
		const write = (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
		};
		for (const patch of [
			{ stockId: "another-stock-id" },
			{ sessionKey: ".." },
			{ spawnId: "not-bound" },
			{ basename: f.path },
		]) {
			await expect(sendCheckpoint(f.home, { ...request, ...patch }, write)).rejects.toThrow();
		}
		for (const stockId of ["대".repeat(43), "a\u0085b", "\ud800"]) {
			writeFileSync(f.path, line({ type: "session", id: stockId }));
			await expect(sendCheckpoint(f.home, { ...request, stockId }, write)).rejects.toThrow();
		}
		writeFileSync(f.path, title("first") + title("second") + session);
		await expect(sendCheckpoint(f.home, request, write)).rejects.toThrow();
		writeFileSync(f.path, line({ type: "message" }) + session);
		await expect(sendCheckpoint(f.home, request, write)).rejects.toThrow();
		writeFileSync(f.path, session.trimEnd());
		await expect(sendCheckpoint(f.home, request, write)).rejects.toThrow();
		writeFileSync(f.path, session);
		truncateSync(f.path, 512 * 1024 * 1024 + 1);
		await expect(sendCheckpoint(f.home, request, write)).rejects.toThrow();
		expect(chunks).toHaveLength(0);
	});

	it("delivers a multi-MiB record in bounded, ordered writes to a backpressured consumer", async () => {
		const f = fixture(session);
		const part = Buffer.alloc(32 * 1024, 0x61);
		const expected = createHash("sha256").update(session);
		let size = Buffer.byteLength(session);
		const append = (data: string | Buffer) => {
			appendFileSync(f.path, data);
			expected.update(data);
			size += Buffer.byteLength(data);
		};
		append('{"type":"message","content":"');
		for (let i = 0; i < 128; i++) append(part);
		append('"}\n');
		let header = false;
		let received = 0;
		let sealed = false;
		const actual = createHash("sha256");
		const digest = expected.digest("hex");
		let consuming = false;
		await sendCheckpoint(f.home, request, async chunk => {
			expect(consuming).toBe(false);
			consuming = true;
			if (!header) {
				expect(JSON.parse(chunk.toString()).bytes).toBe(size);
				header = true;
			} else if (received < size) {
				await setImmediate();
				expect(chunk.buffer.byteLength).toBeLessThanOrEqual(128 * 1024);
				received += chunk.length;
				actual.update(chunk);
			} else {
				expect(JSON.parse(chunk.toString())).toEqual({ sha256: digest });
				sealed = true;
			}
			consuming = false;
		});
		expect(received).toBe(size);
		expect(actual.digest("hex")).toBe(digest);
		expect(sealed).toBe(true);
	});
});
