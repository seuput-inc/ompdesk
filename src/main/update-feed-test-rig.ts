/**
 * A stand-in for api.github.com on 127.0.0.1 for the release lookup tests: the core's client reaches it as the
 * updater's mirror (`setup::net::routed`: `https://api.github.com/x` is `<mirror>/api.github.com/x`).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setUpdateNetwork } from "./update-release";

export interface SeenRequest {
	/** The address the updater asked for, as it named it (`https://api.github.com/...`). */
	url: string;
	headers: http.IncomingHttpHeaders;
}

export interface FeedServer {
	requests: SeenRequest[];
	close: () => Promise<void>;
}

/**
 * Serves `answer` for every request (`stall`: the headers, then nothing; `silent`: nothing at all) and points the
 * updater's network at it.
 */
export async function serveFeed(answer: { status?: number; body: string } | "stall" | "silent"): Promise<FeedServer> {
	const requests: SeenRequest[] = [];
	const held = new Set<http.ServerResponse>();
	const server = http.createServer((request, response) => {
		requests.push({ url: `https:/${request.url ?? ""}`, headers: request.headers });
		if (answer === "silent") {
			held.add(response);
			return;
		}
		if (answer === "stall") {
			response.writeHead(200, { "content-type": "application/json" });
			response.write("[");
			held.add(response);
			return;
		}
		response.writeHead(answer.status ?? 200, { "content-type": "application/json" }).end(answer.body);
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	setUpdateNetwork({ proxy: async () => undefined, mirror: `http://127.0.0.1:${port}` });
	return {
		requests,
		close: async () => {
			for (const response of held) response.destroy();
			server.closeAllConnections();
			await new Promise<void>(resolve => server.close(() => resolve()));
		},
	};
}
