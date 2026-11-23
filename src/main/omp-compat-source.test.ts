import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { CoreError, CoreProcess } from "./core/process";
import { nativeBinPath } from "./native-bin";
import { OmpCompatSource, type OmpCompatSourceDeps } from "./omp-compat-source";

const LIST = { "0.135.0": { verified: ["19.0.0"], holding: null } };

function diskCache() {
	const userData = mkdtempSync(join(tmpdir(), "omp-compat-"));
	const host = new CoreProcess({ binary: () => nativeBinPath("ompdesk-core") });
	onTestFinished(async () => {
		await host.shutdown();
		rmSync(userData, { recursive: true, force: true });
	});
	return { userData, host };
}

function source(replies: (() => Response)[], cache: OmpCompatSourceDeps["cache"] = null) {
	const clock = { now: 0 };
	let reads = 0;
	const compat = new OmpCompatSource({
		cache,
		fetch: async () => {
			const reply = replies[Math.min(reads, replies.length - 1)];
			reads++;
			return reply();
		},
		now: () => clock.now,
	});
	onTestFinished(() => compat.dispose());
	return { compat, clock, reads: () => reads };
}

describe("OmpCompatSource", () => {
	it("reads at most every 15 minutes", async () => {
		const s = source([() => Response.json(LIST)]);
		expect(await s.compat.read()).toEqual(LIST);
		s.clock.now = 14 * 60_000;
		await s.compat.read();
		expect(s.reads()).toBe(1);
		s.clock.now = 15 * 60_000;
		await s.compat.read();
		expect(s.reads()).toBe(2);
	});

	it("keeps the last good list through a failed read, a refused shape and an outage", async () => {
		const s = source([
			() => Response.json(LIST),
			() => Response.json({ "0.135.0": { verified: ["^20.0.0"], holding: null } }),
			() => new Response("bad gateway", { status: 502 }),
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		await s.compat.read();
		for (let i = 1; i <= 3; i++) {
			s.clock.now = i * 15 * 60_000;
			expect(await s.compat.read()).toEqual(LIST);
		}
	});

	it("reads no list yet as nothing verified", async () => {
		const s = source([() => new Response("404: Not Found", { status: 404 })]);
		expect(await s.compat.read()).toEqual({});
	});

	it("a launch without network follows what an earlier launch read, and nothing before any read", async () => {
		const cache = diskCache();
		const file = join(cache.userData, "omp-compat.json");
		const offline = () => {
			throw new TypeError("fetch failed");
		};
		expect(await source([offline], cache).compat.read()).toBeNull();
		const text = `${JSON.stringify(LIST, null, 2)}\r\n`;
		const first = source([() => new Response(text)], cache);
		await first.compat.read();
		expect(readFileSync(file, "utf8")).toBe(text);
		first.compat.dispose();
		await cache.host.stop();
		const restart = source([offline, () => new Response(null, { status: 404 })], cache);
		expect(await Promise.all([restart.compat.read(), restart.compat.read()])).toEqual([LIST, LIST]);
		expect(restart.reads()).toBe(1);
		// The offline read does not start a freshness window.
		expect(await restart.compat.read()).toEqual({});
		expect(readFileSync(file, "utf8")).toBe("{}\n");
		restart.compat.dispose();
		// A kept copy that was tampered with is not used.
		writeFileSync(file, JSON.stringify({ "0.135.0": { verified: ["latest"], holding: null } }));
		expect(await source([offline], cache).compat.read()).toBeNull();
	});

	it("the core limits both directions to 1 MiB of UTF-8 at the fixed cache name", async () => {
		const { userData, host } = diskCache();
		const file = join(userData, "omp-compat.json");
		const read = async () => (await host.call("setup.readCompatCache", { userData })).bin;
		const save = (bin: Uint8Array) => host.call("setup.saveCompatCache", { userData }, { bin });
		const limit = Buffer.from("{}".padEnd(1024 * 1024));
		const oversized = Buffer.concat([limit, Buffer.from(" ")]);
		const malformed = Uint8Array.of(0xe2, 0x82);
		expect(await read()).toBeNull();
		await save(limit);
		expect(Buffer.compare((await read())!, limit)).toBe(0);
		for (const bytes of [oversized, malformed]) {
			await expect(save(bytes)).rejects.toMatchObject({ code: "invalid_params" });
			expect(readFileSync(file).equals(limit)).toBe(true);
			writeFileSync(file, bytes);
			expect(await read()).toBeNull();
			await save(limit);
		}
		await expect(host.call("setup.readCompatCache", { userData, file: "other.json" })).rejects.toMatchObject({
			code: "invalid_params",
		});
	});

	it("stops reading oversized network bodies and keeps the exact last good bytes after invalid UTF-8", async () => {
		const cache = diskCache();
		const good = Buffer.from(`\ufeff${JSON.stringify(LIST)}\r\n`);
		const cancel = vi.fn();
		const tooLarge = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(1024 * 1024));
						controller.enqueue(Uint8Array.of(1));
					},
					cancel,
				}),
			);
		// A replacement decoder would accept the duplicate key's last value as a good list.
		const malformed = Buffer.concat([
			Buffer.from('{"0.135.0":"'),
			Uint8Array.of(0xff),
			Buffer.from('","0.135.0":{"verified":[],"holding":null}}'),
		]);
		const s = source([() => new Response(good), tooLarge, () => new Response(malformed)], cache);
		expect(await s.compat.read()).toEqual(LIST);
		s.clock.now += 15 * 60_000;
		expect(await s.compat.read()).toEqual(LIST);
		expect(cancel).toHaveBeenCalledOnce();
		expect(await s.compat.read()).toEqual(LIST);
		expect(readFileSync(join(cache.userData, "omp-compat.json")).equals(good)).toBe(true);
	});

	it("saves an accepted list when the core dies with the request still outstanding", async () => {
		const cache = diskCache();
		const { host, userData } = cache;
		await host.call("core.echo");
		const call = host.call.bind(host);
		const held = Promise.withResolvers<void>();
		vi.spyOn(host, "call").mockImplementationOnce((_method, _params, options) => {
			const pending = call("core.echo", { waitFor: "interrupted-compat-save" }, options);
			held.resolve();
			return pending;
		});
		const s = source([() => Response.json(LIST)], cache);
		const accepted = s.compat.read();
		await held.promise;
		host.abandon("test interrupted the save");
		await host.call("core.echo");
		expect(await accepted).toEqual(LIST);
		const file = join(userData, "omp-compat.json");
		await vi.waitFor(() => expect(readFileSync(file, "utf8")).toBe(JSON.stringify(LIST)), { timeout: 5_000 });
		expect(s.reads()).toBe(1);
	});

	it("a restart reading the old file cannot replay over a newer accepted list", async () => {
		const cache = diskCache();
		const { host, userData } = cache;
		const real = host.call.bind(host);
		await real("core.echo");
		const lookup = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const calls = vi.spyOn(host, "call").mockImplementationOnce(async (_method, _params, options) => {
			options?.onEnded?.();
			throw new CoreError("io", "EDQUOT: cache pending in the old core");
		});
		const s = source([() => new Response("{}"), () => Response.json(LIST)], cache);
		await s.compat.read();
		await host.stop();
		calls.mockImplementationOnce(async (...args) => {
			const answer = await real(...args);
			lookup.resolve();
			await release.promise;
			return answer;
		});
		await real("core.echo");
		await lookup.promise;
		s.clock.now += 15 * 60_000;
		try {
			expect(await s.compat.read()).toEqual(LIST);
		} finally {
			release.resolve();
		}
		await real("core.echo");
		expect(calls.mock.calls.filter(([method]) => method === "setup.saveCompatCache")).toHaveLength(2);
		expect(readFileSync(join(userData, "omp-compat.json"), "utf8")).toBe(JSON.stringify(LIST));
	});

	it("after a core restart replays only the newest pending list, and nothing from a disposed source", async () => {
		const cache = diskCache();
		const { host, userData } = cache;
		const file = join(userData, "omp-compat.json");
		writeFileSync(file, "{}\n");
		const generation = (await host.call("core.echo")).generation;
		const real = host.call.bind(host);
		const replays: Uint8Array[] = [];
		const saved = Promise.withResolvers<void>();
		vi.spyOn(host, "call").mockImplementation(async (method, params, options) => {
			if (method === "setup.saveCompatCache" && host.generation === generation) {
				options?.onEnded?.();
				throw new CoreError("io", "ENOSPC: cache pending in the old core");
			}
			const answer = await real(method, params, options);
			if (method === "setup.saveCompatCache") {
				replays.push(options!.bin!);
				saved.resolve();
			}
			return answer;
		});
		const previous = source([() => new Response("{}")], cache);
		await previous.compat.read();
		previous.compat.dispose();
		const newest = `\t${JSON.stringify(LIST)}\n`;
		const s = source([() => new Response("{} "), () => new Response(newest), () => new Response("broken")], cache);
		await s.compat.read();
		s.clock.now += 15 * 60_000;
		expect(await s.compat.read()).toEqual(LIST);
		s.clock.now += 15 * 60_000;
		expect(await s.compat.read()).toEqual(LIST);
		expect(readFileSync(file, "utf8")).toBe("{}\n");
		await host.stop();
		await host.call("core.echo");
		await saved.promise;
		expect(readFileSync(file, "utf8")).toBe(newest);
		expect(replays.map(bytes => Buffer.from(bytes).toString())).toEqual([newest]);
	});
});
