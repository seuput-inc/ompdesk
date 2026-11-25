import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { constants, createDeflate, createGzip, deflateSync, gzipSync } from "node:zlib";

// update-auth.ts classifies the HTTP status; a 401 without a challenge is not a network failure.
export async function assertUnauthorizedWithoutChallenge(net) {
	const server = createServer((_request, response) => {
		response.writeHead(401, { "content-type": "application/json" });
		response.end('{"message":"Bad credentials"}');
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const response = await net.fetch(`http://127.0.0.1:${server.address().port}/`, {
			credentials: "omit",
			signal: AbortSignal.timeout(5000),
		});
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { message: "Bad credentials" });
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}

// WinHTTP returns encoded bytes unless native decompression is enabled.
export async function assertCompressedJson(net) {
	const value = { message: "compressed response", unicode: "한글" };
	const bytes = Buffer.from(JSON.stringify(value));
	const server = createServer((request, response) => {
		const encoding = request.url.slice(1);
		assert.match(request.headers["accept-encoding"], new RegExp(encoding));
		response.writeHead(200, {
			"content-type": "application/json",
			"content-encoding": encoding,
		});
		response.end(encoding === "gzip" ? gzipSync(bytes) : deflateSync(bytes));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		for (const encoding of ["gzip", "deflate"]) {
			const response = await net.fetch(
				`http://127.0.0.1:${server.address().port}/${encoding}`,
				{
					credentials: "omit",
					headers: { "Accept-Encoding": encoding },
					signal: AbortSignal.timeout(5000),
				},
			);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), value);
		}
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}

export async function assertCompressedStream(net) {
	let pending;
	const server = createServer((request, response) => {
		const encoding = request.url.slice(1);
		response.writeHead(200, { "content-encoding": encoding });
		response.flushHeaders();
		const compressor = encoding === "gzip" ? createGzip() : createDeflate();
		pending = compressor;
		compressor.pipe(response);
		response.on("close", () => compressor.destroy());
		compressor.write("first");
		compressor.flush(constants.Z_SYNC_FLUSH);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		for (const encoding of ["gzip", "deflate"]) {
			const response = await net.fetch(`http://127.0.0.1:${server.address().port}/${encoding}`, {
				credentials: "omit",
				headers: { "Accept-Encoding": encoding },
				signal: AbortSignal.timeout(5000),
			});
			const reader = response.body.getReader();
			let first = "";
			while (first.length < 5) {
				const next = await reader.read();
				assert.equal(next.done, false);
				first += new TextDecoder().decode(next.value);
			}
			assert.equal(first, "first");
			pending.end("last");
			let tail = "";
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				tail += new TextDecoder().decode(next.value);
			}
			assert.equal(tail, "last");
		}
	} finally {
		pending?.destroy();
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}
