import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { core } from "./core/process";
import { ompPackageRoot } from "./omp-runtime";
import { StockSessionStore } from "./session-store";
import { stockHelperHost, stopStockHelper } from "./stock-helper";
import { INSTALLED_OMP } from "./test-bridge-probe";

const index = "synthetic-list-enrichment";
const previousAgent = process.env.PI_CODING_AGENT_DIR;
let dir: string;
let root: string;
let file: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-enrichment-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	root = path.join(dir, "sessions");
	file = path.join(root, "project", "a.jsonl");
	await fs.mkdir(path.dirname(file), { recursive: true });
});

afterEach(async () => {
	await core().call("sessions.close", { index });
	await stopStockHelper();
	if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgent;
	await fs.rm(dir, { recursive: true, force: true });
});

it.skipIf(!ompPackageRoot(INSTALLED_OMP))("refreshes both listings after a partial title finishes", async () => {
	const store = new StockSessionStore(root, path.resolve("resources/gui-bridge"), index);
	const timestamp = "2026-11-01T00:00:00Z";
	const lines = [
		{ type: "title", v: 1, title: "mine", source: "user", updatedAt: timestamp, pad: "   " },
		{ type: "session", version: 3, id: "s1", cwd: dir, timestamp },
		{ type: "title_change", title: "was", source: "auto" },
		{ type: "title_change", title: "mine", source: "user" },
		{ type: "message", message: { role: "user", content: "test", timestamp: 47.8 } },
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	const partial = JSON.stringify({ type: "custom", customType: "ompdesk.auto-title", data: { title: "새 제목" } });
	for (const [append, at, autoTitle] of [
		["", 47, "was"],
		[partial, 47, "was"],
		["\n", 47, "새 제목"],
		['{"type":"message","timestamp":"2026-11-21T00:00:00Z"}', 1795219200000, "새 제목"],
	] as const) {
		await fs.appendFile(file, append);
		const expected = {
			id: "s1",
			firstMessage: "test",
			modified: new Date(at).toISOString(),
			title: "mine",
			autoTitle,
		};
		expect(await store.list()).toMatchObject([expected]);
		expect(await store.listDirectory(file)).toMatchObject([expected]);
	}
});

it.skipIf(!ompPackageRoot(INSTALLED_OMP))("lists the newest date Bun accepts in a restored journal", async () => {
	const store = new StockSessionStore(root, path.resolve("resources/gui-bridge"), index);
	const header = { type: "session", version: 3, id: "restored", cwd: dir, timestamp: "2026-11-01T00:00:00Z" };
	const message = { role: "user", content: "restored prompt" };
	const lines = [
		header,
		{ type: "message", message: { ...message, timestamp: 1 } },
		{ type: "message", message, timestamp: "Thu, 01 Jan 1970 01:02:03 GMT (\ud800)" },
		{ type: "message", message, timestamp: "not a date" },
	];
	await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	const expected = { id: "restored", modified: "1970-01-01T01:02:03.000Z" };
	expect(await store.list()).toMatchObject([expected]);
	expect(await store.listDirectory(file)).toMatchObject([expected]);
	await fs.appendFile(file, `${JSON.stringify({ type: "message", message, timestamp: "Jan 1 1970 00:00 GMT" })}\n`);
	expect(await store.listDirectory(file)).toMatchObject([{ ...expected, modified: "1970-01-01T00:00:00.000Z" }]);
	const undated = [{ ...header, id: "undated" }, { type: "message", message, timestamp: "unknown" }];
	await fs.writeFile(file, `${undated.map(line => JSON.stringify(line)).join("\n")}\n`);
	const mtime = new Date("2020-01-01T00:00:00.000Z");
	await fs.utimes(file, mtime, mtime);
	expect(await store.list()).toMatchObject([{ id: "undated", modified: mtime.toISOString() }]);
});

it("forgets absent rows only on a full list and never reads outside its root", async () => {
	const message = (at: number) => JSON.stringify({ type: "message", message: { timestamp: at } });
	const row = { path: file, id: "a", modified: "fixed", size: Buffer.byteLength(message(1)) };
	const read = async (rows: (typeof row)[], full: boolean, under = root) =>
		(await core().call("sessions.enrich", { root: under, index, rows, full, host: stockHelperHost() })).result;
	await fs.writeFile(file, message(1));
	expect(await read([row], true)).toEqual([{ row: 0, at: 1 }]);
	await fs.writeFile(file, message(2));
	await read([], false);
	expect(await read([row], false)).toEqual([{ row: 0, at: 1 }]);
	await read([], true);
	expect(await read([row], false)).toEqual([{ row: 0, at: 2 }]);
	const other = path.join(dir, "other");
	await fs.mkdir(other);
	expect(await read([row], true, other)).toEqual([]);
	const missing = { ...row, path: path.join(root, "missing.jsonl") };
	expect(await read([missing], false)).toEqual([]);
	await fs.writeFile(missing.path, message(3));
	expect(await read([missing], false)).toEqual([{ row: 0, at: 3 }]);
});
