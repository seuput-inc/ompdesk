import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderInput } from "../shared/ipc-types";
import { LOCAL_ENGINES, type LocalEngineSpec, type LocalEnginesLedger } from "../shared/local-engines";
import { stopCore } from "./core/process";
import { LocalEngineDetector, localEngineSettings, probeLocalEngine } from "./local-engines";
import { deadMirror, startMirror } from "./setup/test-mirror";

const FREETOKEN: LocalEngineSpec = { id: "freetoken", name: "FreeToken", baseUrl: "http://127.0.0.1:1919/v1" };
const COLIBRI: LocalEngineSpec = { id: "colibri", name: "colibri", baseUrl: "http://127.0.0.1:8000/v1" };
const INTERVAL = 60_000;

interface Gate {
	release(): void;
	promise: Promise<void>;
}
function gate(): Gate {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { release: resolve, promise };
}
function rig() {
	const world = {
		up: new Set<string>(),
		uninspected: new Set<string>(),
		file: new Set<string>(),
		ledger: { registered: [], removed: [] } as LocalEnginesLedger,
		enabled: true,
		probes: 0,
		probeError: null as Error | null,
		changed: 0,
		upserts: [] as CustomProviderInput[],
		deletes: [] as string[],
		failures: [] as unknown[],
		hold: null as Gate | null,
		deleteFails: 0,
	};
	const engines = [FREETOKEN, COLIBRI];
	const detector = new LocalEngineDetector({
		engines,
		ledger: {
			get: () => structuredClone(world.ledger),
			set: value => {
				world.ledger = structuredClone(value);
			},
		},
		enabled: () => world.enabled,
		probe: async baseUrl => {
			world.probes++;
			if (world.probeError) throw world.probeError;
			const id = engines.find(engine => engine.baseUrl === baseUrl)?.id ?? "";
			const answer = world.uninspected.has(id) ? null : world.up.has(id);
			await world.hold?.promise;
			return answer;
		},
		providers: {
			ids: async () => new Set(world.file),
			insert: async input => {
				if (world.file.has(input.id)) return false;
				world.upserts.push(input);
				world.file.add(input.id);
				return true;
			},
			delete: async id => {
				if (world.deleteFails > 0) {
					world.deleteFails--;
					throw new Error("disk full");
				}
				world.deletes.push(id);
				world.file.delete(id);
			},
		},
		changed: () => void world.changed++,
		failed: error => void world.failures.push(error),
		intervalMs: INTERVAL,
	});
	return { world, detector };
}

describe("localEngineSettings", () => {
	const table = JSON.stringify([{ id: "fake", name: "Fake", baseUrl: "http://127.0.0.1:5555/v1" }]);

	it("takes a test table and pause from the environment on an unpackaged launch", () => {
		expect(
			localEngineSettings(
				{ OMP_GUI_TEST_LOCAL_ENGINES: table, OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: "250" },
				false,
			),
		).toEqual({ engines: JSON.parse(table), intervalMs: 250 });
	});

	it("keeps the real table and pause for a packaged app, a bad table and a bad pause", () => {
		const real = { engines: LOCAL_ENGINES, intervalMs: 60_000 };
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: table }, true)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: '[{"id":1}]' }, false)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINES: "nope" }, false)).toEqual(real);
		expect(localEngineSettings({ OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS: "0" }, false)).toEqual(real);
		expect(localEngineSettings({}, false)).toEqual(real);
	});
});

describe("LocalEngineDetector", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers an engine that answers as a discovery-only provider and tells the windows once", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		expect(world.upserts).toEqual([
			{
				id: "freetoken",
				api: "openai-completions",
				baseUrl: "http://127.0.0.1:1919/v1",
				auth: "none",
				discovery: { type: "openai-models-list" },
				models: [],
			},
		]);
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		expect(world.changed).toBe(1);
		// Nothing changed in the next pass: no second write, no second push.
		await detector.tick();
		expect(world.upserts).toHaveLength(1);
		expect(world.changed).toBe(1);
	});

	it("unregisters an entry when its engine stops answering, and registers it again when it returns", async () => {
		const { world, detector } = rig();
		world.up.add("colibri");
		await detector.tick();
		world.up.delete("colibri");
		await detector.tick();
		expect(world.file.has("colibri")).toBe(false);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
		expect(world.changed).toBe(2);
		world.up.add("colibri");
		await detector.tick();
		expect(world.file.has("colibri")).toBe(true);
		expect(world.changed).toBe(3);
	});

	it("never makes an entry again that the person deleted, while the engine keeps answering", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.file.delete("freetoken");
		await detector.tick();
		expect(world.ledger).toEqual({ registered: [], removed: ["freetoken"] });
		await detector.tick();
		await detector.tick();
		expect(world.upserts).toHaveLength(1);
		// The tombstone changed nothing in models.yml, so it pushed nothing.
		expect(world.changed).toBe(1);
	});

	it("leaves an entry of the same id that the person made alone, up or down", async () => {
		const { world, detector } = rig();
		world.file.add("freetoken");
		world.up.add("freetoken");
		await detector.tick();
		world.up.clear();
		await detector.tick();
		expect(world.file.has("freetoken")).toBe(true);
		expect(world.upserts).toEqual([]);
		expect(world.deletes).toEqual([]);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
		expect(world.changed).toBe(0);
	});

	it("turning the switch off removes every entry it wrote, and none of the person's", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken").add("colibri");
		await detector.tick();
		expect(world.file).toEqual(new Set(["freetoken", "colibri"]));
		world.file.delete("colibri");
		await detector.tick();
		world.enabled = false;
		await detector.setEnabled(false);
		expect(world.file.size).toBe(0);
		expect(world.ledger.registered).toEqual([]);
		// The tombstone survives while off; a pass while off does nothing at all.
		const before = world.probes;
		await detector.tick();
		expect(world.probes).toBe(before);
	});

	it("turning the switch on again registers at once and keeps what the person deleted", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.up.add("colibri");
		await detector.tick();
		world.file.delete("freetoken");
		await detector.tick();
		expect(world.ledger.removed).toEqual(["freetoken"]);
		world.enabled = false;
		await detector.setEnabled(false);
		expect(world.file.size).toBe(0);
		world.enabled = true;
		await detector.setEnabled(true);
		expect(world.ledger).toEqual({ registered: ["colibri"], removed: ["freetoken"] });
		expect(world.file.has("colibri")).toBe(true);
		expect(world.file.has("freetoken")).toBe(false);
	});

	it("a deletion right before the switch goes off is a tombstone too: on again does not bring it back", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.file.delete("freetoken");
		world.enabled = false;
		await detector.setEnabled(false);
		expect(world.ledger).toEqual({ registered: [], removed: ["freetoken"] });
		expect(world.deletes).toEqual([]);
		world.enabled = true;
		await detector.setEnabled(true);
		expect(world.file.has("freetoken")).toBe(false);
		expect(world.ledger).toEqual({ registered: [], removed: ["freetoken"] });
	});

	it("a pass that began before the switch went off writes nothing", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.hold = gate();
		const pass = detector.tick();
		await vi.advanceTimersByTimeAsync(0);
		world.enabled = false;
		const off = detector.setEnabled(false);
		world.hold.release();
		await Promise.all([pass, off]);
		expect(world.upserts).toEqual([]);
		expect(world.file.size).toBe(0);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
	});

	it("a provider the person adds while the probe runs is theirs: not overwritten, not claimed by the ledger", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.hold = gate();
		const pass = detector.tick();
		await vi.advanceTimersByTimeAsync(0);
		world.file.add("freetoken");
		world.hold.release();
		await pass;
		expect(world.upserts).toEqual([]);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
		expect(world.changed).toBe(0);
		// Engine down later: the person's entry is not the detector's to delete.
		world.up.delete("freetoken");
		await detector.tick();
		expect(world.deletes).toEqual([]);
		expect(world.file.has("freetoken")).toBe(true);
	});

	it("runs one pass for any number of callers at once", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		world.hold = gate();
		const calls = [detector.tick(), detector.tick(), detector.tick()];
		await vi.advanceTimersByTimeAsync(0);
		world.hold.release();
		await Promise.all(calls);
		expect(world.probes).toBe(2);
		expect(world.upserts).toHaveLength(1);
		await detector.tick();
		expect(world.probes).toBe(4);
	});

	it("starts with a pass, then waits the interval after each pass ends", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(world.probes).toBe(2);
		await vi.advanceTimersByTimeAsync(INTERVAL - 1);
		expect(world.probes).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(world.probes).toBe(4);
		world.up.clear();
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.file.size).toBe(0);
	});

	it("does not stack a pass on one still running when the interval elapses", async () => {
		const { world, detector } = rig();
		world.hold = gate();
		detector.start();
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		expect(world.probes).toBe(2);
		world.hold.release();
		await vi.advanceTimersByTimeAsync(0);
		world.hold = null;
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.probes).toBe(4);
	});

	it("stops the timer while off and restarts it when turned on", async () => {
		const { world, detector } = rig();
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		world.enabled = false;
		await detector.setEnabled(false);
		const before = world.probes;
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		expect(world.probes).toBe(before);
		world.enabled = true;
		await detector.setEnabled(true);
		expect(world.probes).toBe(before + 2);
		await vi.advanceTimersByTimeAsync(INTERVAL);
		expect(world.probes).toBe(before + 4);
	});

	it("does nothing after dispose, not even a timer already waiting", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		detector.start();
		await vi.advanceTimersByTimeAsync(0);
		const probes = world.probes;
		detector.dispose();
		await vi.advanceTimersByTimeAsync(INTERVAL * 3);
		await detector.tick();
		expect(world.probes).toBe(probes);
	});

	it("keeps an entry whose removal failed, owned, and removes it on the next pass", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.up.clear();
		world.deleteFails = 1;
		await detector.tick();
		expect(world.failures).toHaveLength(1);
		expect(world.file.has("freetoken")).toBe(true);
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		await detector.tick();
		expect(world.file.has("freetoken")).toBe(false);
		expect(world.ledger).toEqual({ registered: [], removed: [] });
	});

	it("leaves owned entries alone when the core cannot report whether an engine is up", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		world.probeError = new Error("core exited");
		await detector.tick();
		expect(world.file.has("freetoken")).toBe(true);
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		expect(world.failures).toHaveLength(1);
	});

	it("an uninspectable reply preserves the provider, not another engine that really went offline", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken").add("colibri");
		await detector.tick();
		world.up.clear();
		world.uninspected.add("freetoken");
		await detector.tick();
		expect(world.file).toEqual(new Set(["freetoken"]));
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		world.file.delete("freetoken");
		await detector.tick();
		expect(world.ledger).toEqual({ registered: [], removed: ["freetoken"] });
	});

	it("reads an unreadable models.yml as no decision, not as every entry gone", async () => {
		const { world, detector } = rig();
		world.up.add("freetoken");
		await detector.tick();
		const broken = new LocalEngineDetector({
			engines: [FREETOKEN],
			ledger: {
				get: () => structuredClone(world.ledger),
				set: value => {
					world.ledger = structuredClone(value);
				},
			},
			enabled: () => true,
			probe: async () => true,
			providers: {
				ids: async () => {
					throw new Error("invalid YAML");
				},
				insert: async () => true,
				delete: async () => {},
			},
			changed: () => void world.changed++,
			failed: error => void world.failures.push(error),
			intervalMs: INTERVAL,
		});
		await broken.tick();
		expect(world.ledger).toEqual({ registered: ["freetoken"], removed: [] });
		expect(world.failures).toHaveLength(1);
	});
});

describe("probeLocalEngine", () => {
	afterAll(stopCore);

	it("requests the OpenAI model list from the real core without registering individual models", async () => {
		const methods: (string | undefined)[] = [];
		const mirror = await startMirror((_url, request) => {
			methods.push(request.method);
			return { status: 299, body: '{"data":[{"id":"m"}]}' };
		});
		try {
			await expect(probeLocalEngine(`${mirror.url}/v1///`)).resolves.toBe(true);
			expect(mirror.asked).toEqual(["https://v1/models"]);
			expect(methods).toEqual(["GET"]);
		} finally {
			await mirror.close();
		}
	});

	it("is down on a bad status, wrong shape, invalid JSON, refused socket or timed-out body", async () => {
		const mirror = await startMirror((_url, request) => {
			switch (request.url) {
				case "/status/models":
					return { status: 503, body: '{"data":[]}' };
				case "/shape/models":
					return '{"data":"x"}';
				case "/null/models":
					return "null";
				case "/stall/models":
					return (_req, res) => {
						res.write('{"data":[');
					};
				default:
					return "bad JSON";
			}
		});
		try {
			const bases = ["status", "shape", "null", "bad", "stall"].map(path => `${mirror.url}/${path}`);
			bases.push(await deadMirror());
			await expect(Promise.all(bases.map(probeLocalEngine))).resolves.toEqual(bases.map(() => false));
		} finally {
			await mirror.close();
		}
	});

	it("follows loopback redirects, preserves the localhost Host header and never dials a rejected hop", async () => {
		const mirror = await startMirror((_url, request) => {
			const redirect = (location: string) => ({ status: 302, headers: { location } });
			switch (request.url) {
				case "/v1/models":
					return redirect("/relative");
				case "/relative":
					return redirect(`${mirror.url.replace("127.0.0.1", "localhost")}/catalog`);
				// Even a regressed client can reach only this fixture. The mapped IPv4 host is outside the allowlist.
				case "/refused/models":
					return redirect(`${mirror.url.replace("127.0.0.1", "[::ffff:127.0.0.1]")}/no`);
				default:
					return '{"data":[]}';
			}
		});
		try {
			await expect(probeLocalEngine(`${mirror.url}/v1`)).resolves.toBe(true);
			expect(mirror.headers[2]?.host).toBe(new URL(mirror.url).host.replace("127.0.0.1", "localhost"));
			await expect(probeLocalEngine(`${mirror.url}/refused`)).resolves.toBe(false);
			await expect(probeLocalEngine(mirror.url.replace("127.0.0.1", "[::ffff:127.0.0.1]"))).resolves.toBe(false);
			await expect(probeLocalEngine(mirror.url.replace("http:", "https:"))).resolves.toBe(false);
			await expect(probeLocalEngine("not a url")).resolves.toBe(false);
			expect(mirror.asked).toEqual([
				"https://v1/models",
				"https://relative",
				"https://catalog",
				"https://refused/models",
			]);
		} finally {
			await mirror.close();
		}
	});

	it("follows twenty allowed redirects but does not send a twenty-first redirected GET", async () => {
		const mirror = await startMirror((_url, request) => {
			const left = Number(request.url?.split("/")[1]);
			return left > 0 ? { status: 308, headers: { location: `/${left - 1}` } } : '{"data":[]}';
		});
		try {
			await expect(probeLocalEngine(`${mirror.url}/20`)).resolves.toBe(true);
			await expect(probeLocalEngine(`${mirror.url}/21`)).resolves.toBe(false);
			expect(mirror.asked).toHaveLength(42);
			expect(mirror.asked.at(-1)).toBe("https://1");
		} finally {
			await mirror.close();
		}
	});

	it("reads the same gzip, zlib, raw deflate, Brotli and stacked model lists as fetch", async () => {
		const list = Buffer.from('{"data":[]}');
		const gzip = gzipSync(list);
		const replies = [
			{ coding: "gzip", body: gzip },
			{ coding: "gzip", body: gzip.subarray(0, -4) },
			{ coding: "x-gzip", body: gzip },
			{ coding: "deflate", body: deflateSync(list) },
			{ coding: "deflate", body: deflateRawSync(list) },
			{ coding: "br", body: brotliCompressSync(list) },
			{ coding: "GZip, Br", body: brotliCompressSync(gzip) },
			{ coding: "unknown", body: list },
		];
		const mirror = await startMirror((_url, req) => {
			const reply = replies[Number(req.url?.split("/")[1])];
			return reply && { headers: { "content-encoding": reply.coding }, body: reply.body };
		});
		try {
			const results = await Promise.all(replies.map((_, i) => probeLocalEngine(`${mirror.url}/${i}`)));
			expect(results).toEqual(replies.map(() => true));
			expect(mirror.headers.every(headers => headers["accept-encoding"] === "gzip, deflate")).toBe(true);
		} finally {
			await mirror.close();
		}
	});

	it("does not classify a body declared over 64 MiB or an unsupported zstd reply as offline", async () => {
		const mirror = await startMirror((_url, req) => {
			if (req.url === "/zstd/models") return { headers: { "content-encoding": "zstd" }, body: "encoded" };
			return (_request, response) => {
				response.writeHead(200, { "content-length": 64 * 1024 * 1024 + 1 });
				response.flushHeaders();
			};
		});
		try {
			await expect(probeLocalEngine(mirror.url)).resolves.toBeNull();
			await expect(probeLocalEngine(`${mirror.url}/zstd`)).resolves.toBeNull();
		} finally {
			await mirror.close();
		}
	});
});
