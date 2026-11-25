import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { GuiBridgeClient, newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";
import { garbled } from "./test-mojibake";

/**
 * Stock's idle maintenance (`AgentSession.enableIdleMaintenance`) as the bridge opts a GUI session into it
 * (resources/gui-bridge/idle-maintenance.ts): the installed omp in `rpc-ui` mode with the whole bridge, a fake
 * OpenAI-compatible provider on 127.0.0.1 and the bridge's draft report sent as main sends it. Stock decides when;
 * these cases pin what OMPdesk supplies: the GUI draft holds the recap back and clearing it lets it run (and re-arms
 * idle compaction, the same scheduler and the same `isBlocked`), a settings write through the bridge re-arms, a
 * recap reaches the transcript as a `recap` card the next model request leaves out, and a mojibake recap is neither
 * shown nor journaled.
 *
 * The negative waits run past the configured delay (1 s for the recap): absence of a timer's work can only be seen by
 * letting its time pass. Idle compaction runs on stock's shortest configured delay (60 s), not ahead of a long-tier
 * prompt cache entry: whether stock still counts that entry as current after a turn differs between machines.
 */

type Frame = {
	type: string;
	id?: string;
	reason?: string;
	message?: { role?: string; customType?: string; content?: unknown; details?: unknown };
	[key: string]: unknown;
};

const REPLY = "  You are building the thing.\n Next: run the tests.  ";
const PREVIEW = "You are building the thing. Next: run the tests.";

function sse(text: string): string {
	const frame = (body: Record<string, unknown>) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", ...body })}\n\n`;
	return [
		frame({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
		frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }),
		frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
		frame({ choices: [], usage: { prompt_tokens: 5000, completion_tokens: 10, total_tokens: 5010 } }),
		"data: [DONE]\n\n",
	].join("");
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
	// Two omps end on stdin's close; each may take seconds to journal its exit.
}, 90_000);

/**
 * Answers stock's recap prompts with `recapReplies` in turn (the last one repeated) and everything else with "DONE";
 * keeps every request body and counts the recap answers sent in full.
 */
async function startProvider(
	recapReplies: readonly string[] = [REPLY],
): Promise<{ url: string; bodies: string[]; recaps(): number; recapsAnswered(): number }> {
	const bodies: string[] = [];
	let answered = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!isRecapRequest(body)) {
				res.end(sse("DONE"));
				return;
			}
			const index = bodies.filter(isRecapRequest).length - 1;
			res.end(sse(recapReplies[Math.min(index, recapReplies.length - 1)] ?? REPLY), () => {
				answered++;
			});
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return {
		url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
		bodies,
		recaps: () => bodies.filter(isRecapRequest).length,
		recapsAnswered: () => answered,
	};
}

/** The recaps stock journaled in the private agent dir's history.db (`session_recaps`), oldest first. */
function journaledRecaps(dir: string): string[] {
	const file = readdirSync(dir, { recursive: true })
		.map(entry => join(dir, String(entry)))
		.find(path => path.endsWith("history.db"));
	if (!file) return [];
	const db = new DatabaseSync(file, { readOnly: true });
	try {
		return db
			.prepare("SELECT recap FROM session_recaps ORDER BY id")
			.all()
			.map(row => String(row.recap));
	} finally {
		db.close();
	}
}

/** Stock's `prompts/system/recap-user.md`. */
function isRecapRequest(body: string): boolean {
	return body.includes("User stepped away");
}

interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	bridge: GuiBridgeClient;
	/** Sends a prompt and resolves once its run ended. */
	turn(message: string): Promise<void>;
	/** The private folder holding the agent dir and its history.db. */
	dir: string;
}

async function startOmp(url: string, config: string): Promise<Omp> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-idle-maintenance-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-idle-maintenance-repo-")));
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        reasoning: false\n        contextWindow: 200000\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	writeFileSync(join(agentDir, "config.yml"), config);
	const address = newBridgeAddress();
	const childEnv: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: configDirName(isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	// XDG folders would move history.db out of the private agent dir.
	for (const key of [
		"ELECTRON_RUN_AS_NODE",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"ANTHROPIC_OAUTH_TOKEN",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
	])
		Reflect.deleteProperty(childEnv, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			"fake/m1",
			"-e",
			resolve("resources/gui-bridge/index.ts"),
		],
		{ cwd: root, env: childEnv as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	const bridge = new GuiBridgeClient(address);
	cleanups.push(async () => {
		bridge.close();
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	});
	const frames: Frame[] = [];
	const responses = new Map<string, (frame: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	await expect
		.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000, message: stderr })
		.toBe(true);
	await bridge.connect();
	let counter = 0;
	const send = (command: Record<string, unknown>) =>
		new Promise<Frame>(done => {
			const id = `c${++counter}`;
			responses.set(id, done);
			child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		});
	return {
		frames,
		send,
		bridge,
		dir: isolated,
		turn: async message => {
			const ends = frames.filter(frame => frame.type === "agent_end").length;
			await send({ type: "prompt", message });
			await expect
				.poll(() => frames.filter(frame => frame.type === "agent_end").length, { timeout: 30_000, message: stderr })
				.toBeGreaterThan(ends);
		},
	};
}

function recapCards(frames: Frame[]): Frame["message"][] {
	return frames
		.filter(frame => frame.type === "message_end" && frame.message?.customType === "recap")
		.map(frame => frame.message);
}

describe.skipIf(!existsSync(omp))("idle maintenance on stock omp through the bridge", () => {
	it("holds the recap while the draft has text, shows it once cleared, re-arms on a settings write and keeps it from the model", async () => {
		const provider = await startProvider();
		const { frames, bridge, turn } = await startOmp(
			provider.url,
			"recap:\n  enabled: true\n  idleSeconds: 1\ncompaction:\n  idleEnabled: false\n",
		);
		expect(await bridge.request("idle_maintenance_draft", { empty: false })).toEqual({ empty: false });
		await turn("Build the thing");
		await sleep(2_500);
		expect(provider.recaps()).toBe(0);

		await bridge.request("idle_maintenance_draft", { empty: true });
		await expect.poll(() => recapCards(frames).length, { timeout: 15_000 }).toBe(1);
		// The card shows stock's one-line preview; the whole reply (as stock's ephemeral turn returned it) rides along.
		expect(recapCards(frames)[0]).toMatchObject({ content: PREVIEW, details: { recap: REPLY.trim() } });

		// A long delay through the bridge's own settings write, then a short one: stock's listener re-arms.
		await bridge.request("settings_set", { path: "recap.idleSeconds", value: 3600 });
		const before = provider.bodies.length;
		await turn("Now the next part");
		// The card is in the session, never in what the model is sent.
		const next = provider.bodies.slice(before).filter(body => !isRecapRequest(body));
		expect(next.length).toBeGreaterThan(0);
		for (const body of next) expect(body).not.toContain("You are building the thing");
		await bridge.request("settings_set", { path: "recap.idleSeconds", value: 1 });
		await expect.poll(() => recapCards(frames).length, { timeout: 15_000 }).toBe(2);
	}, 120_000);

	it("arms idle compaction again once a held draft clears, and stock runs it", async () => {
		const provider = await startProvider();
		const { frames, bridge, turn } = await startOmp(
			provider.url,
			"recap:\n  enabled: false\ncompaction:\n  idleEnabled: true\n  idleThresholdTokens: 1\n  idleTimeoutSeconds: 60\n",
		);
		const idleStarts = () =>
			frames.filter(frame => frame.type === "auto_compaction_start" && frame.reason === "idle").length;
		await bridge.request("idle_maintenance_draft", { empty: false });
		await turn("Build the thing");
		expect(idleStarts()).toBe(0);
		// Held at the turn's end, so nothing is armed; only the clear's refresh arms stock's 60 s delay.
		await bridge.request("idle_maintenance_draft", { empty: true });
		await expect.poll(idleStarts, { timeout: 90_000, interval: 1_000 }).toBe(1);
	}, 150_000);

	it("neither shows nor journals a recap the model wrote as mojibake", async () => {
		const provider = await startProvider([garbled("지금 테스트를 고치는 중입니다. 다음은 빌드입니다."), REPLY]);
		const { frames, bridge, turn, dir } = await startOmp(
			provider.url,
			"recap:\n  enabled: true\n  idleSeconds: 1\ncompaction:\n  idleEnabled: false\n",
		);
		await bridge.request("idle_maintenance_draft", { empty: true });
		await turn("Build the thing");
		await expect.poll(provider.recapsAnswered, { timeout: 15_000 }).toBe(1);
		// Stock journals the reply as soon as its side turn has read it; the next turn would abort an unfinished one.
		await sleep(1_000);
		await turn("Now the next part");
		await expect.poll(() => recapCards(frames).length, { timeout: 15_000 }).toBe(1);
		expect(recapCards(frames)[0]).toMatchObject({ content: PREVIEW });
		// Only the clean recap reached history.db, which also proves the read finds stock's journal.
		expect(journaledRecaps(dir)).toEqual([REPLY.trim()]);
	}, 120_000);
});
