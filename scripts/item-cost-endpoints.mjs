// One app-window IPC endpoint and one sealed device socket per case. These are boundary tests, not a WebView benchmark.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { ItemFeedViewers } from "../src/main/bots";
import { core } from "../src/main/core/process";
import {
	BOTS_EVENT,
	ITEMS_CHANGE_METHOD,
	ITEMS_V2_METHOD,
	ITEMS_V2_CHANGED as PEER_CHANGED,
} from "../src/main/remote/app-protocol";
import { RemoteHost } from "../src/main/remote/host-server";
import { LocalHostServices } from "../src/main/remote/host-services";
import { Link as Reader } from "../src/main/remote/test-legacy-peer";
import { ShellClient } from "../src/main/shell-host/client";
import { Host } from "../src/main/shell-host/electron/host";
import { IpcMain, serveIpc } from "../src/main/shell-host/electron/ipc-main";
import { WebContents } from "../src/main/shell-host/electron/web-contents";
import { BOTS_COMMAND, BOTS_STATE, ITEMS_V2_CHANGE, ITEMS_V2_CHANGED, ITEMS_V2_QUERY } from "../src/shared/bots";
import { parseItemsV2Reply } from "../src/shared/items-v2";

const sharing = {}; // One host at a time, as in the app's process-wide device-to-host routing table.

async function accept(dial) {
	const server = createServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const [[socket], other] = await Promise.all([once(server, "connection"), dial(server.address().port)]);
		socket.setNoDelay(true);
		return [socket, other];
	} finally {
		server.close();
	}
}

export async function windowEndpoint(call, notice) {
	const [socket, remote] = await accept(async port => {
		const s = connect(port, "127.0.0.1");
		await once(s, "connect");
		return s.setNoDelay(true);
	});
	const frames = [0, 0];
	for (const [i, endpoint] of [remote, socket].entries())
		endpoint.on("data", chunk => {
			// This item IPC has JSON lines only (no binary tails).
			for (let n = chunk.indexOf(10); n >= 0; n = chunk.indexOf(10, n + 1)) frames[i]++;
		});
	const main = new ShellClient(socket);
	const shell = new ShellClient(remote);
	const host = new Host(main, { displays: [] });
	const wc = new WebContents(host, 1, { partition: "", windowId: 1 }, () => {
		throw new Error("no WebView in probe");
	});
	const ipc = new IpcMain();
	serveIpc(host, ipc);
	const viewers = new ItemFeedViewers();
	ipc.handle(BOTS_COMMAND, (_e, r) => {
		viewers.legacyRead(wc.id);
		return call("bots", r);
	});
	ipc.handle(ITEMS_V2_CHANGE, (_e, device, request) => call("itemsChange", { device, request }));
	ipc.handle(ITEMS_V2_QUERY, (_e, device, request) => {
		const query = async () =>
			parseItemsV2Reply(request, await call("itemsQuery", { request: { ...request, device } }));
		return request.action === "itemsFeed"
			? viewers.read(wc.id, device, data => wc.send(ITEMS_V2_CHANGED, data), query)
			: query();
	});
	shell.on("wc.send", ({ channel, args }) => notice(channel, args[0]));
	const invoke = async (channel, ...args) =>
		(await shell.call("ipc.invoke", { wcId: 1, frameUrl: "app://ompdesk/", channel, args })).value;
	return {
		invoke,
		legacy: state => {
			if (viewers.wantsLegacy(wc.id)) wc.send(BOTS_STATE, state);
		},
		changed: () => viewers.changed(null, false),
		counters: () => [remote.bytesRead, socket.bytesRead, ...frames],
		close() {
			shell.close();
			main.close();
		},
	};
}

export async function peerEndpoint(call, notice, legacyAudience) {
	const receive = randomBytes(32),
		send = randomBytes(32);
	const [socket, { result }] = await accept(port =>
		core().call("remote.testLink", {
			address: `127.0.0.1:${port}`,
			sendKey: receive.toString("hex"),
			receiveKey: send.toString("hex"),
		}),
	);
	const reader = new Reader(socket);
	reader.secure(send, receive);
	reader.deflateSent({ context: true });
	core().push("remote.deflate", { link: result.link, context: true });
	const services = new LocalHostServices({
		localTabs: {},
		machine: { abortBenchmark: async () => true, abortModelSetup: async () => true },
		bots: () => ({
			share: () => call("botsShare", {}),
			from: (request, device, deviceName) => call("botsFrom", { device, deviceName, request }),
			itemsV2: request => call("itemsQueryFrom", { request }),
			itemsChange: request => call("itemsChangeFrom", { request }),
		}),
	});
	const unsubscribe = legacyAudience && services.onLegacyBotsAudience(legacyAudience);
	const host = new RemoteHost({ sharing, services, name: () => "Host", hello: () => ({}), appVersion: "0.153.0" });
	// Skip the login handshake only. Requests, subscriptions, fanout, replies, encryption and decoding are real.
	await host.answerAsk({
		link: result.link,
		peer: { deviceId: "peer-demo", name: "Peer" },
		hello: { name: "Peer", appVersion: "0.153.0", slim: {} },
	});
	let id = 1000;
	const pending = new Map();
	const traffic = [];
	reader.onTraffic((dir, message, bytes) => traffic.push([dir, message.method ?? message.event ?? message.t, bytes]));
	reader.listen(m => {
		if (m.t === "evt") notice(m.event, m.data);
		else if (m.t === "res") {
			const waiter = pending.get(m.id);
			assert(waiter, `unexpected peer response ${m.id}`);
			pending.delete(m.id);
			if (m.ok) waiter.resolve(m.result);
			else waiter.reject(new Error(JSON.stringify(m.error)));
		}
	});
	const invoke = (method, params) => {
		const waiter = Promise.withResolvers();
		pending.set(++id, waiter);
		reader.send({ t: "req", id, method, params });
		return waiter.promise;
	};
	return {
		invoke,
		services,
		traffic,
		close() {
			unsubscribe?.();
			reader.destroy();
		},
	};
}

export const channels = {
	BOTS_COMMAND,
	BOTS_STATE,
	ITEMS_V2_CHANGE,
	ITEMS_V2_CHANGED,
	ITEMS_V2_QUERY,
	BOTS_EVENT,
	ITEMS_CHANGE_METHOD,
	PEER_CHANGED,
	ITEMS_V2_METHOD,
};
