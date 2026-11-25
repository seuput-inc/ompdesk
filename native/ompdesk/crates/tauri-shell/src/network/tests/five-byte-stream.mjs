import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";

// Pass the real createNet(host) consumer, connected to the native host; never a fake transport.
export async function assertFiveByteStream(net) {
	const responses = new Set();
	const server = createServer((_request, response) => {
		responses.add(response);
		response.on("close", () => responses.delete(response));
		response.writeHead(200, { "content-type": "text/plain" });
		response.flushHeaders();
		response.write("first");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	const abort = new AbortController();
	try {
		// Confirm the same origin actually flushes headers and the exact five-byte HTTP chunk.
		const socket = connect({ host: "127.0.0.1", port });
		try {
			await once(socket, "connect");
			socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
			let raw = "";
			while (!raw.includes("\r\n\r\n5\r\nfirst\r\n")) {
				const [data] = await once(socket, "data", { signal: AbortSignal.timeout(5000) });
				raw += data.toString("latin1");
			}
			assert.match(raw, /transfer-encoding: chunked/i);
		} finally {
			socket.destroy();
			await once(socket, "close");
		}
		const response = await net.fetch(`http://127.0.0.1:${port}/`, {
			credentials: "omit",
			cache: "no-store",
			signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
		});
		assert.equal(response.status, 200);
		const reader = response.body.getReader();
		const first = await reader.read();
		assert.equal(new TextDecoder().decode(first.value), "first");
		// The origin stays open until the native head and original five bytes both arrived.
		for (const pending of responses) pending.end("last");
		let tail = "";
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			tail += new TextDecoder().decode(next.value);
		}
		assert.equal(tail, "last");
	} finally {
		abort.abort();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}
