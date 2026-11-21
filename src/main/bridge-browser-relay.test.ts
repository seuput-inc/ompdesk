/**
 * Agent browsing against the installed omp: the gui-bridge starts stock's own
 * browser relay inside the session, holds `browser.relay`/`browser.relayUrl`
 * as runtime overrides, and the preview's relay extension (main/preview/
 * agent-relay.ts) completes stock's extension handshake so the relay offers
 * the preview page as its one CDP target.
 */
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PreviewRelayExtension, type RelayDebugger, relayExtensionUrl } from "./preview/agent-relay";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";
import { type StockPreviewRelay, startStockBrowserSession } from "./test-stock-browser-session";

class IdleDebugger extends EventEmitter {
	attach(): void {}
	detach(): void {}
	isAttached(): boolean {
		return false;
	}
	async sendCommand(): Promise<unknown> {
		return {};
	}
}

describe.skipIf(!existsSync(omp))("stock browser relay bridge", () => {
	it("serves stock's relay for the session and lists the preview once its extension says hello", async () => {
		const { client, close } = await startStockBrowserSession();
		let socket: WebSocket | null = null;
		try {
			await client.request("default_browser_set", { browser: { kind: "unavailable", name: "Brave" } });
			const enabled = () => client.request("settings_get", { paths: ["browser.enabled"] });
			await expect(enabled()).resolves.toMatchObject({ values: { "browser.enabled": false } });

			const relay = await client.request<StockPreviewRelay>("browser.relay_start");
			expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			// A second start reuses the running relay.
			expect(await client.request("browser.relay_start")).toEqual(relay);
			await expect(enabled()).resolves.toMatchObject({ values: { "browser.enabled": true } });
			const held = JSON.stringify(
				await client.request("settings_get", { paths: ["browser.relay", "browser.relayUrl"] }),
			);
			expect(held).toContain(relay.url);

			const before = await fetch(`${relay.url}/json/version`);
			expect(before.status).toBe(503);
			expect(await before.json()).toMatchObject({ error: "relay extension is not connected" });
			const target = relayExtensionUrl(relay.extensionUrl ?? relay.url, relay.token);
			if (!target) throw new Error("relay endpoint refused");
			const refused = await fetch(target.replace("ws://", "http://").replace(relay.token, "wrong"));
			expect(refused.status).toBe(401);
			const foreignOrigin = await fetch(target.replace("ws://", "http://"), {
				headers: { Origin: "https://example.com" },
			});
			expect(foreignOrigin.status).toBe(403);
			if (relay.extensionUrl) expect((await fetch(`${relay.url}/ext?token=${relay.token}`)).status).toBe(404);

			const extension = new PreviewRelayExtension(
				{
					id: 41,
					url: () => "https://example.com/",
					title: () => "Example Domain",
					userAgent: () => "Mozilla/5.0 Chrome/138.0.0.0 Electron/36.9.5",
					// Only the listener and attach surface is exercised before puppeteer connects.
					debugger: new IdleDebugger() as unknown as RelayDebugger,
					ensureRenderer: async () => {},
				},
				message => socket?.send(JSON.stringify(message)),
				() => {},
			);
			const opened = Promise.withResolvers<void>();
			socket = new WebSocket(target);
			socket.addEventListener("open", () => opened.resolve());
			socket.addEventListener("error", () => opened.reject(new Error("extension socket failed")));
			socket.addEventListener("message", message => extension.handle(String(message.data)));
			await opened.promise;
			socket.send(JSON.stringify(extension.hello("ompdesk-preview-test")));
			await expect.poll(async () => (await fetch(`${relay.url}/json/version`)).status, { timeout: 5_000 }).toBe(200);
			expect(await (await fetch(`${relay.url}/json/list`)).json()).toEqual([
				expect.objectContaining({ type: "page", title: "Example Domain", url: "https://example.com/" }),
			]);

			await client.request("browser.relay_stop");
			await expect(enabled()).resolves.toMatchObject({ values: { "browser.enabled": false } });
			await expect(fetch(`${relay.url}/json/version`)).rejects.toThrow();
			expect(JSON.stringify(await client.request("settings_get", { paths: ["browser.relayUrl"] }))).not.toContain(
				relay.url,
			);
		} finally {
			socket?.close();
			await close();
		}
	}, 60_000);
});
