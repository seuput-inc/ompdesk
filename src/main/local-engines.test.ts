import { brotliCompressSync, deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { LOCAL_ENGINES } from "../shared/local-engines";
import { core, stopCore } from "./core/process";
import { localEngineSettings } from "./local-engines";
import { deadMirror, startMirror } from "./setup/test-mirror";

// The detector's own cases (a stand-in world, paused time) are in `native/ompdesk/crates/core/src/models/detect`.

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

/** The real core's probe, as the detector asks it: null means the reply could not be inspected. */
async function probeLocalEngine(baseUrl: string): Promise<boolean | null> {
	return (await core().call<boolean | null>("models.probeLocalEngine", { baseUrl })).result;
}

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
