import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixture, until } from "./test-context";

describe("the native routine-marks journal", () => {
	it("keeps the legacy byte order, private mode and trigger key; unchanged reopen and quit preserve every byte", async () => {
		const f = await fixture();
		for (const name of ["10", "2", "a"]) {
			const path = join(f.work, name);
			writeFileSync(path, "x");
			utimesSync(path, 1_700_000_000, 1_700_000_000);
		}
		const event = { source: "files" as const, path: f.work };
		const id = await f.add(event);
		const mark = {
			listing: { entries: { 2: "1700000000000:1", 10: "1700000000000:1", a: "1700000000000:1" }, complete: true },
		};
		const expected = JSON.stringify({ version: 1, marks: { [id]: { key: JSON.stringify([event, null]), mark } } });
		await until(() => expect(readFileSync(f.file, "utf8")).toBe(expected));
		if (process.platform !== "win32") expect(statSync(f.file).mode & 0o777).toBe(0o600);
		await f.close();
		expect(readFileSync(f.file, "utf8")).toBe(expected);
		await f.reopen();
		await f.service.command({ action: "setEnabled", id, enabled: false });
		await f.close();
		expect(readFileSync(f.file, "utf8")).toBe('{"version":1,"marks":{}}');
		expect(f.fired).toEqual([]);
	});

	it.each(["{invalid", "null", '"scalar"', "[]"])("leaves an unreadable, untouched journal alone: %s", async text => {
		const f = await fixture();
		await f.close();
		writeFileSync(f.file, text);
		await f.reopen();
		await f.close();
		expect(readFileSync(f.file, "utf8")).toBe(text);
	});

	it("never treats a saved mark for a different trigger as this one's baseline", async () => {
		const ready = Promise.withResolvers<void>();
		const f = await fixture({ ready: ready.promise });
		const id = await f.add({ source: "files", path: f.work });
		writeFileSync(
			f.file,
			JSON.stringify({
				version: 1,
				marks: {
					[id]: { key: "other trigger", mark: { listing: { complete: true, entries: { old: "1:2" } } } },
					gone: { key: "deleted", mark: {} },
					broken: { key: 4 },
				},
			}),
		);
		ready.resolve();
		await until(() => expect(f.marks()[id]?.mark).toEqual({ listing: { entries: {}, complete: true } }));
		await f.close();
		expect(Object.keys(f.marks())).toEqual([id]);
		expect(f.fired).toEqual([]);
	});
});
