import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { latestTurnStart, transcriptPageMessages } from "../../resources/gui-bridge/transcript-page";

export interface TurnFixture {
	messages: { role: string; steering?: boolean; [field: string]: unknown }[];
	onPage?: "moveLeaf" | "grow" | "codedError" | "plainError" | "hold";
}

export interface TurnPageRequest {
	offset: number;
	limit: number;
	turnStart?: boolean;
}

const { messages, onPage }: TurnFixture = JSON.parse(readFileSync("transcript.json", "utf8"));
writeFileSync("pages.jsonl", "");
const address = process.env.OMP_GUI_BRIDGE;
if (!address) throw new Error("stand-in needs a GUI bridge address");
createServer(socket => {
	createInterface({ input: socket }).on("line", line => {
		const { id, method, params } = JSON.parse(line);
		const reply = (frame: object) => socket.write(`${JSON.stringify({ id, ...frame })}\n`);
		if (method !== "sessions.transcript") return reply({ ok: false, error: `Unexpected method: ${method}` });
		const { offset, limit, turnStart }: TurnPageRequest = params;
		appendFileSync("pages.jsonl", `${JSON.stringify(params)}\n`);
		if (limit > 0) {
			if (onPage === "hold") return;
			if (onPage === "codedError") return reply({ ok: false, error: "Replay unavailable", code: "unsupported_omp" });
			if (onPage === "plainError") return reply({ ok: false, error: "Replay unavailable" });
		}
		reply({
			ok: true,
			result: {
				leafId: limit > 0 && onPage === "moveLeaf" ? "new-leaf" : "leaf",
				total: messages.length + Number(limit > 0 && onPage === "grow"),
				startIndex: offset,
				...(turnStart ? { turnStart: latestTurnStart(messages) } : {}),
				messages: transcriptPageMessages(messages.slice(offset, offset + limit)),
			},
		});
	});
}).listen(address, () =>
	console.log(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] })),
);
createInterface({ input: process.stdin })
	.on("line", line => {
		const { id, type } = JSON.parse(line);
		console.log(
			JSON.stringify({
				type: "response",
				id,
				command: type,
				success: type === "get_state",
				data: { sessionId: "fixture" },
			}),
		);
	})
	.on("close", () => process.exit(0));
