/**
 * Handing a session to a paired computer, both sides real: this computer's `handOffSession` and tombstone record, the
 * other computer's `remote.handoff.*` in the core (the requests `LocalHostServices` would make), over a link this test
 * cuts. After every case exactly one computer can run the session, and during an outage at most one.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { codedError, ipcErrorCode } from "../shared/ipc-error-codes";
import { core } from "./core/process";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import { handOffParts } from "./session-handoff";
import { type HandOffDeps, handOffSession, reconcileHandOffs, type SessionTabs } from "./session-mutations";

const FILE = "2026-11-26T00-00-00-000Z_s1.jsonl";
const PICTURE = Buffer.from("a picture");

let root: string;
let a: { file: string; sessions: string; blobs: string; record: string };
let b: { userData: string; sessions: string; blobs: string; folder: string };

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "handoff-"));
	a = {
		sessions: join(root, "a", "sessions"),
		blobs: join(root, "a", "blobs"),
		file: join(root, "a", "sessions", FILE),
		record: join(root, "a", "deleted-sessions.json"),
	};
	b = {
		userData: join(root, "b", "profile"),
		sessions: join(root, "b", "sessions"),
		blobs: join(root, "b", "blobs"),
		folder: join(root, "b", "project"),
	};
	for (const dir of [a.sessions, a.blobs, b.userData, b.folder]) mkdirSync(dir, { recursive: true });
	initDeletedSessions(a.record);
	const header = { type: "session", id: "s1", cwd: join(root, "a", "project"), version: 3 };
	const message = { type: "message", content: [{ type: "image", data: `blob:sha256:${pictureHash()}` }] };
	writeFileSync(a.file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
	mkdirSync(join(a.sessions, FILE.slice(0, -6), "tool"), { recursive: true });
	writeFileSync(join(a.sessions, FILE.slice(0, -6), "tool", "out.txt"), "output");
	writeFileSync(join(a.blobs, pictureHash()), PICTURE);
});

afterEach(() => {
	initDeletedSessions(null);
	rmSync(root, { recursive: true, force: true });
});

function pictureHash(): string {
	return createHash("sha256").update(PICTURE).digest("hex");
}

const target = () => join(b.sessions, FILE);

/** Which computer could run the session now: its file is there and no tombstone holds it. */
function runnable(): string[] {
	return [
		...(existsSync(a.file) && !deletedSessions().has(a.file) ? ["a"] : []),
		...(existsSync(target()) && !deletedSessions().has(target()) ? ["b"] : []),
	];
}

/** The other computer's side of the link: `LocalHostServices`' four cases, calling the core as they do. */
function link() {
	const state = {
		down: false,
		/** Answers of these methods are lost after their effect, and the link goes down with them. */
		loses: new Set<string>(),
		/** A commit held on the wire: it reaches the other computer only when the test lets it. */
		holdCommit: false,
		held: [] as (() => Promise<unknown>)[],
	};
	const call = async (method: string, params: object, bin?: Buffer) =>
		(await core().call(method, { ...params, userData: b.userData, from: "dev-a" }, bin ? { bin } : {})).result;
	const serve = (method: string, params: Record<string, unknown>): Promise<unknown> => {
		switch (method) {
			case "sessions.handoff.folder":
				return Promise.resolve({ folder: b.folder });
			case "sessions.handoff.put": {
				const { dataBase64, ...part } = params;
				return call("remote.handoff.put", part, Buffer.from(String(dataBase64), "base64"));
			}
			case "sessions.handoff.commit":
				return call("remote.handoff.commit", { ...params, sessionDir: b.sessions, blobsDir: b.blobs });
			case "sessions.handoff.abort":
				return call("remote.handoff.abort", params);
		}
		throw new Error(`unknown ${method}`);
	};
	const request = async <T>(_host: string, method: string, params: unknown): Promise<T> => {
		if (state.down) throw codedError("remote_offline", "The computer is offline");
		if (method === "sessions.handoff.commit" && state.holdCommit) {
			state.held.push(() => serve(method, params as Record<string, unknown>));
			state.down = true;
			throw codedError("remote_offline", "The link dropped");
		}
		const answer = await serve(method, params as Record<string, unknown>);
		if (state.loses.has(method)) {
			state.down = true;
			throw codedError("remote_offline", "The link dropped");
		}
		return answer as T;
	};
	return { state, request };
}

function deps(request: HandOffDeps["request"]): HandOffDeps & { relist: Mock<() => void> } {
	return {
		request,
		recordedCwd: async () => join(root, "a", "project"),
		origin: async () => null,
		parts: sessionPath => handOffParts(sessionPath, a.blobs),
		removeStored: async sessionPath => {
			rmSync(sessionPath, { force: true });
			rmSync(sessionPath.slice(0, -6), { recursive: true, force: true });
		},
		relist: vi.fn<() => void>(),
	};
}

function tabs(running = false): SessionTabs & { closed: string[] } {
	const closed: string[] = [];
	return {
		closed,
		sessionOwner: () => null,
		sessionOwnerIsLive: () => false,
		sessionRunning: () => running,
		commandForSession: vi.fn(async () => null),
		noteSessionName: () => {},
		closeSessionTab: vi.fn(async (sessionPath: string) => {
			closed.push(sessionPath);
			return !running;
		}),
	};
}

/** The session landed on the other computer whole, and this computer keeps only the tombstone naming where. */
function expectMoved(): void {
	expect(runnable()).toEqual(["b"]);
	expect(existsSync(a.file)).toBe(false);
	const [header] = readFileSync(target(), "utf8").split("\n");
	expect(JSON.parse(header ?? "")).toMatchObject({ type: "session", id: "s1", cwd: b.folder });
	expect(readFileSync(join(b.sessions, FILE.slice(0, -6), "tool", "out.txt"), "utf8")).toBe("output");
	expect(readFileSync(join(b.blobs, pictureHash()))).toEqual(PICTURE);
	expect(deletedSessions().pendingHandoffs()).toEqual([]);
	expect(deletedSessions().list().at(-1)).toMatchObject({ handoff: { device: "host-b", to: target() } });
}

describe("handOffSession", () => {
	it("moves the journal, its artifacts and its pictures, and the session runs only on the other computer", async () => {
		const { request } = link();
		const sides = tabs();
		const moved = await handOffSession(sides, a.file, "host-b", deps(request));
		expect(moved).toEqual({ sessionPath: target(), cwd: b.folder });
		expect(sides.closed).toEqual([a.file]);
		expectMoved();
	});

	it("refuses before anything moves while the session runs, or when the other computer has no folder of its project", async () => {
		const { request } = link();
		const running = tabs(true);
		const refused = await handOffSession(running, a.file, "host-b", deps(request)).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("session_running");
		const noFolder: HandOffDeps["request"] = async <T>(host: string, method: string, params: unknown) =>
			(method === "sessions.handoff.folder" ? { folder: null } : await request(host, method, params)) as T;
		const missing = await handOffSession(tabs(), a.file, "host-b", deps(noFolder)).catch((error: unknown) => error);
		expect(ipcErrorCode(missing)).toBe("handoff_project_missing");
		expect(runnable()).toEqual(["a"]);
		expect(deletedSessions().list()).toEqual([]);
	});

	it("a lost answer to the commit still ends with the session on the other computer once", async () => {
		const { state, request } = link();
		state.loses.add("sessions.handoff.commit");
		// The link comes straight back for the question that follows.
		const flaky: HandOffDeps["request"] = async (host, method, params) => {
			if (method === "sessions.handoff.abort") state.down = false;
			return request(host, method, params);
		};
		const moved = await handOffSession(tabs(), a.file, "host-b", deps(flaky));
		expect(moved.sessionPath).toBe(target());
		expectMoved();
	});

	it("keeps the session pending, running nowhere, while the other computer cannot answer, across a restart", async () => {
		const { state, request } = link();
		state.loses.add("sessions.handoff.commit");
		const refused = await handOffSession(tabs(), a.file, "host-b", deps(request)).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("handoff_pending");
		// The other computer took it; this one keeps its file but runs it nowhere.
		expect(runnable()).toEqual(["b"]);
		expect(existsSync(a.file)).toBe(true);
		// This computer restarts: the record read again still holds it back.
		initDeletedSessions(a.record);
		expect(deletedSessions().has(a.file)).toBe(true);
		expect(deletedSessions().pendingHandoffs()).toMatchObject([{ path: a.file, device: "host-b" }]);
		// The link comes back: asked again, the other computer owns it, and this copy goes.
		state.down = false;
		state.loses.clear();
		await reconcileHandOffs("host-b", deps(request));
		expectMoved();
	});

	it("gives the session back only once the other computer has called the transfer off, and a late commit is refused", async () => {
		const { state, request } = link();
		state.holdCommit = true;
		const refused = await handOffSession(tabs(), a.file, "host-b", deps(request)).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("handoff_pending");
		expect(runnable()).toEqual([]);
		initDeletedSessions(a.record);
		state.down = false;
		state.holdCommit = false;
		const settled = deps(request);
		await reconcileHandOffs("host-b", settled);
		expect(settled.relist).toHaveBeenCalled();
		expect(runnable()).toEqual(["a"]);
		expect(deletedSessions().list()).toEqual([]);
		// The commit that was on the wire reaches the other computer after the abort: refused, nothing lands.
		const late = await state.held[0]?.().catch((error: unknown) => error);
		expect(late).toMatchObject({ code: "handoff_aborted" });
		expect(runnable()).toEqual(["a"]);
	});

	it("a commit sent twice lands one session", async () => {
		const { request } = link();
		const sent: { method: string; params: unknown }[] = [];
		const recording: HandOffDeps["request"] = async (host, method, params) => {
			sent.push({ method, params });
			return request(host, method, params);
		};
		await handOffSession(tabs(), a.file, "host-b", deps(recording));
		const commit = sent.find(step => step.method === "sessions.handoff.commit");
		expect(await request("host-b", "sessions.handoff.commit", commit?.params)).toEqual({ sessionPath: target() });
		expectMoved();
	});

	it("a pending transfer of another computer is left alone, and a reconcile with nothing pending asks nothing", async () => {
		const request = vi.fn(async () => {
			throw new Error("asked");
		});
		await reconcileHandOffs("host-b", deps(request));
		expect(request).not.toHaveBeenCalled();
		deletedSessions().beginHandoff(a.file, "11111111-2222-4333-8444-555555555555", "host-c");
		await reconcileHandOffs("host-b", deps(request));
		expect(request).not.toHaveBeenCalled();
		expect(runnable()).toEqual([]);
	});
});
