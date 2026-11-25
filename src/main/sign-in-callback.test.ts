import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { core } from "./core/process";
import { advanceCoreTimers, fakeCoreTimers, realCoreTimers } from "./core/test-clock";
import { replaySignInCallback, SIGN_IN_PAGE_MAX_CHARS } from "./sign-in-callback";

describe("host sign-in callback replay", () => {
	const requests: Array<[string | undefined, string | undefined]> = [];
	const longType = `TeXt/HtMl; fixture=${"x".repeat(220)}`;
	const beforeSplit = "가".repeat(SIGN_IN_PAGE_MAX_CHARS - 1);
	const stalled = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const server = createServer((req, res) => {
		requests.push([req.url, req.headers.host]);
		switch (req.url?.split("?")[0]) {
			case "/redirect":
				res.writeHead(302, { location: "/elsewhere", "content-type": "text/html" }).end("Moved");
				break;
			case "/denied":
				res.writeHead(500, { "content-type": longType }).end(`\uFEFF${beforeSplit}😀tail`);
				break;
			case "/bad-type":
				res.writeHead(400, { "content-type": "text/plainish" }).end(Buffer.from([0xef, 0xbb, 0xbf, 0xff, 65]));
				break;
			case "/short-body":
				res.writeHead(200, { "content-length": SIGN_IN_PAGE_MAX_CHARS * 4 }).end(
					"x".repeat(SIGN_IN_PAGE_MAX_CHARS * 3 + 4),
				);
				break;
			case "/encoded":
				res.writeHead(200, { "content-encoding": "gzip" }).end("not identity");
				break;
			case "/stall":
				res.write("unfinished");
				res.on("close", () => closed.resolve());
				stalled.resolve();
				break;
			default:
				res.writeHead(204).end();
		}
	});
	let port: number;
	beforeAll(async () => {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		port = (server.address() as AddressInfo).port;
	});
	afterAll(async () => {
		const stopped = once(server, "close");
		server.close();
		server.closeAllConnections();
		await stopped;
	});
	const replay = (path: string, query = "") =>
		replaySignInCallback({ url: new URL(`http://localhost:${port}${path}`), state: null }, query);

	it("replaces only the advertised URL's query and returns the redirect without visiting its destination", async () => {
		const start = requests.length;
		expect(await replay("/redirect?old=yes#unused", "?q=one two#three&path=//other")).toEqual({
			status: 302,
			contentType: "text/html",
			body: "Moved",
		});
		expect(requests.slice(start)).toEqual([["/redirect?q=one%20two%23three&path=//other", `localhost:${port}`]]);
	});

	it("keeps the denial status, the first 200 type characters and the first 65536 UTF-16 units", async () => {
		const { body, ...headers } = await replay("/denied");
		expect(headers).toEqual({ status: 500, contentType: longType.slice(0, 200) });
		expect(body.length).toBe(SIGN_IN_PAGE_MAX_CHARS);
		expect(body.charCodeAt(body.length - 1)).toBe(0xd83d);
		expect(body.slice(0, -1)).toBe(beforeSplit);
	});

	it("uses UTF-8 replacement and a plain-text fallback for an unsupported or missing type", async () => {
		expect(await replay("/bad-type")).toEqual({ status: 400, contentType: "text/plain; charset=utf-8", body: "�A" });
		expect(await replay("/empty")).toEqual({ status: 204, contentType: "text/plain; charset=utf-8", body: "" });
	});

	it("rejects a broken response even after the output cap and never returns compressed bytes as text", async () => {
		await expect(replay("/short-body")).rejects.toThrow("callback server did not answer");
		await expect(replay("/encoded")).rejects.toThrow("Unsupported sign-in callback content encoding");
	});

	it("the core's own ten-second deadline closes a response that stalls after its headers", async () => {
		await fakeCoreTimers(["Date"]);
		try {
			const answer = expect(
				core().call("remotebytes.signInReplay", { url: `http://127.0.0.1:${port}/stall`, query: "" }),
			).rejects.toThrow("callback server did not answer");
			await stalled.promise;
			await advanceCoreTimers(10_000);
			await answer;
			await closed.promise;
		} finally {
			await realCoreTimers();
		}
	});
});
