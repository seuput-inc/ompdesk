import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

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
