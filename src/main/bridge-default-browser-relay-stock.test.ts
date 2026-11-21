/** Two isolated sessions on the installed stock CLI must never route a request to the other extension. */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { relayExtensionUrl } from "./preview/agent-relay";
import { INSTALLED_OMP } from "./test-bridge-probe";
import { startStockBrowserSession, type StockPreviewRelay } from "./test-stock-browser-session";

const TAB = { url: "about:blank", title: "", active: true, discarded: false, windowId: 1, pinned: false, groupId: -1 };

interface FakeExtension {
	socket: WebSocket;
	/** The `createTab` requests this extension was asked to perform. */
	created: string[];
}

/** An extension as stock's protocol (relay/protocol.ts) has it: hello, then an answer to every rpc. */
async function connectExtension(relay: StockPreviewRelay, label: string): Promise<FakeExtension> {
	const url = relayExtensionUrl(relay.extensionUrl ?? relay.url, relay.token);
	if (!url) throw new Error("relay endpoint refused");
	const socket = new WebSocket(url);
	const created: string[] = [];
	socket.addEventListener("message", event => {
		const request: { t?: string; id: number; op?: string; url?: string } = JSON.parse(String(event.data));
		if (request.t !== "rpc") return;
		if (request.op === "createTab") created.push(request.url ?? "");
		const result = request.op === "createTab" ? { tab: { ...TAB, tabId: 100, url: request.url ?? "" } } : {};
		socket.send(JSON.stringify({ t: "rpcResult", id: request.id, ok: true, result }));
	});
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve());
	socket.addEventListener("error", () => opened.reject(new Error(`extension ${label} socket failed`)));
	await opened.promise;
	socket.send(
		JSON.stringify({
			t: "hello",
			userAgent: "Mozilla/5.0 Chrome/138.0.0.0",
			browserVersion: "Chrome/138.0.0.0",
			tabs: [{ ...TAB, tabId: 1 }],
			attachedTabIds: [],
			discardedTabsProtocol: 1,
			instanceId: label,
			browserSession: `${label}-run`,
		}),
	);
	await expect
		.poll(async () => (await fetch(relay.url + "/json/version")).status, { timeout: 5_000 })
		.toBe(200);
	return { socket, created };
}

/** One CDP command to a relay's endpoint, as the omp browser tool sends it. */
async function cdp(
	url: string,
	method: string,
	params: object,
): Promise<{ result?: object; error?: { message: string } }> {
	const socket = new WebSocket(url.replace("http:", "ws:") + "/cdp");
	const answer = Promise.withResolvers<{ result?: object; error?: { message: string } }>();
	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as { id?: number; result?: object; error?: { message: string } };
		if (message.id === 1) answer.resolve(message);
	});
	socket.addEventListener("error", () => answer.reject(new Error("cdp socket failed")));
	const opened = Promise.withResolvers<void>();
	socket.addEventListener("open", () => opened.resolve());
	await opened.promise;
	socket.send(JSON.stringify({ id: 1, method, params }));
	try {
		return await answer.promise;
	} finally {
		socket.close();
	}
}

describe.skipIf(!existsSync(INSTALLED_OMP))("default browser relay binding on stock's relay", () => {
	it("opens a tab only in the extension bound to the relay endpoint it was sent to", async () => {
		const a = await startStockBrowserSession();
		let b: Awaited<ReturnType<typeof startStockBrowserSession>> | undefined;
		const extensions: FakeExtension[] = [];
		try {
			b = await startStockBrowserSession();
			const first = await a.client.request<StockPreviewRelay>("browser.relay_start");
			const second = await b.client.request<StockPreviewRelay>("browser.relay_start");
			expect(first.url).not.toBe(second.url);
			expect(first.token).not.toBe(second.token);

			const chrome = await connectExtension(first, "chrome");
			const edge = await connectExtension(second, "edge");
			extensions.push(chrome, edge);

			const toChrome = await cdp(first.url, "Target.createTarget", { url: "https://chrome.example/" });
			expect(toChrome.error).toBeUndefined();
			expect(chrome.created).toEqual(["https://chrome.example/"]);
			expect(edge.created).toEqual([]);

			const toEdge = await cdp(second.url, "Target.createTarget", { url: "https://edge.example/" });
			expect(toEdge.error).toBeUndefined();
			expect(edge.created).toEqual(["https://edge.example/"]);
			expect(chrome.created).toEqual(["https://chrome.example/"]);

			// Chrome's extension goes away: its relay refuses; the tab does not fall to the browser still connected.
			chrome.socket.close();
			await expect
				.poll(async () => (await fetch(first.url + "/json/version")).status, { timeout: 5_000 })
				.toBe(503);
			expect((await fetch(second.url + "/json/version")).status).toBe(200);
			const refused = await cdp(first.url, "Target.createTarget", { url: "https://chrome.example/again" });
			expect(refused.error?.message).toContain("relay extension is not connected");
			expect(edge.created).toEqual(["https://edge.example/"]);
		} finally {
			for (const extension of extensions) extension.socket.close();
			await Promise.all([a.close(), b?.close()]);
		}
	}, 120_000);
});
