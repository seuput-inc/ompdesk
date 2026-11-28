import { createHash } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";
import { SESSION_TAG_PATTERN } from "../runtime-identifiers";
import { openOriginal } from "./original";

const MAX_BYTES = 512 * 1024 * 1024;
const BLOCK_BYTES = 64 * 1024;

type Request = { sessionKey: string; spawnId: string; basename: string; stockId: string };
type Write = (bytes: Buffer) => void | Promise<void>;

function* blocks(fd: number, size: number, buffer: Buffer): Generator<Buffer> {
	for (let offset = 0; offset < size; ) {
		const length = Math.min(buffer.length, size - offset);
		for (let n = 0; n < length; ) {
			const read = readSync(fd, buffer, n, length - n, offset + n);
			if (read === 0) throw new Error("Guest original was truncated");
			n += read;
		}
		offset += length;
		yield buffer.subarray(0, length);
	}
}

// Admit the header within the first 64 KiB, after at most one mutable title slot.
function checkStockHeader(firstBlock: Buffer, stockId: string) {
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for (let start = 0; ; ) {
		const end = firstBlock.indexOf(10, start);
		if (end < 0) break;
		let row: unknown;
		try {
			row = JSON.parse(decoder.decode(firstBlock.subarray(start, end)));
		} catch {
			break;
		}
		if (!row || typeof row !== "object" || !("type" in row)) break;
		if (row.type === "session" && "id" in row && row.id === stockId) return;
		if (start !== 0 || row.type !== "title") break;
		start = end + 1;
	}
	throw new Error("Missing or mismatched stock session header");
}

function frame(value: object): Buffer {
	const line = Buffer.from(`${JSON.stringify(value)}\n`);
	if (line.length > 4096) throw new Error("Oversized checkpoint frame");
	return line;
}

export async function sendCheckpoint(home: string, request: Request, write: Write): Promise<void> {
	const { sessionKey, spawnId, basename, stockId } = request;
	if (process.platform !== "linux" || !process.getuid) throw new Error("A guest Linux original is required");
	if (
		!SESSION_TAG_PATTERN.test(spawnId) ||
		!stockId ||
		Buffer.byteLength(stockId) > 128 ||
		/[\p{Cc}\p{Cs}]/u.test(stockId)
	)
		throw new Error("Invalid checkpoint identity");
	const uid = process.getuid();
	const fd = openOriginal(home, sessionKey, basename, uid);
	try {
		const source = fstatSync(fd, { bigint: true });
		if (!source.size || source.size > BigInt(MAX_BYTES)) throw new Error("Empty or oversized guest original");
		const buffer = Buffer.allocUnsafe(BLOCK_BYTES);
		const capture = createHash("sha256");
		let offset = 0;
		let bytes = 0;
		let captured = "";
		for (const block of blocks(fd, Number(source.size), buffer)) {
			if (!offset) checkStockHeader(block, stockId);
			const lf = block.lastIndexOf(10);
			if (lf >= 0) {
				capture.update(block.subarray(0, lf + 1));
				bytes = offset + lf + 1;
				captured = capture.copy().digest("hex");
			}
			capture.update(block.subarray(lf + 1));
			offset += block.length;
		}

		await write(frame({ v: 1, sessionKey, spawnId, stockId, bytes, source: `${source.dev}:${source.ino}` }));
		const sent = createHash("sha256");
		for (const block of blocks(fd, bytes, buffer)) {
			sent.update(block);
			await write(block);
		}
		if (sent.digest("hex") !== captured) throw new Error("Guest prefix changed during transfer");

		const before = fstatSync(fd, { bigint: true });
		if (before.size < source.size || (before.size === source.size && before.ctimeNs !== source.ctimeNs))
			throw new Error("Guest original changed without an append");
		const fresh = createHash("sha256");
		for (const block of blocks(fd, bytes, buffer)) fresh.update(block);
		const named = openOriginal(home, sessionKey, basename, uid);
		try {
			const after = fstatSync(named, { bigint: true });
			// A writer racing the verification read can change a block we have already checked.
			if (
				after.dev !== source.dev ||
				after.ino !== source.ino ||
				after.size < BigInt(bytes) ||
				after.ctimeNs !== before.ctimeNs ||
				fresh.digest("hex") !== captured
			)
				throw new Error("Guest original changed before seal");
		} finally {
			closeSync(named);
		}
		await write(frame({ sha256: captured }));
	} finally {
		closeSync(fd);
	}
}

if (import.meta.main) {
	try {
		const [, , sessionKey, spawnId, basename, stockId] = process.argv;
		const home = process.env.HOME;
		if (process.argv.length !== 6 || !sessionKey || !spawnId || !basename || !stockId || !home)
			throw new Error("Expected a session key, spawn ID, basename and stock ID");
		await sendCheckpoint(home, { sessionKey, spawnId, basename, stockId }, chunk => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(chunk, error => (error ? reject(error) : resolve()));
			return promise;
		});
	} catch {
		// Filesystem and JSON errors may quote guest paths or journal content.
		process.stderr.write("Could not verify the guest checkpoint.\n");
		process.exitCode = 1;
	}
}
