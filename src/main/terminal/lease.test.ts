import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TerminalLeaseState, TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import { core } from "../core/process";
import type { StockHelper } from "../stock-helper";
import { terminalTestHelper } from "./test-helper";

const DESKTOP = 3;
const PHONE = -1;
const owner = "3:tab";

describe("terminal viewer size through the stock lane", () => {
	let dir: string;
	let helper: StockHelper;
	let id: string;
	let now: number;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "terminal-lease-"));
		helper = await terminalTestHelper(dir);
		now = 1_000_000;
		[{ id }] = await request(DESKTOP, { action: "create", cols: 80, rows: 24 });
	});
	afterEach(async () => {
		await helper?.stop();
		await rm(dir, { recursive: true, force: true });
	});

	function request(viewer: number, operation: TerminalOperation, key = owner) {
		return helper.request<TerminalSnapshot[]>("terminal.viewerRequest", {
			owner: key,
			viewer,
			now,
			cwd: dir,
			env: {},
			operation,
		});
	}

	async function seen(viewer: number, key = owner, terminal = id) {
		const { result } = await core().call<TerminalLeaseState[]>("terminal.viewerSeen", {
			host: helper.host,
			owner: key,
			viewer,
			ids: [terminal],
			now,
		});
		return result[0];
	}

	const resize = (viewer: number, cols: number) => request(viewer, { action: "resize", id, cols, rows: 24 });

	it("orders a claim before a competing resize and samples the holder after the worker replies", async () => {
		expect(await seen(DESKTOP)).toBe("free");
		expect(await resize(DESKTOP, 100)).toMatchObject([{ cols: 100 }]);
		expect(await seen(PHONE)).toBe("other");
		expect(await resize(PHONE, 60)).toMatchObject([{ cols: 100 }]);
		const claim = request(PHONE, { action: "claim", id });
		const later = resize(DESKTOP, 120);
		expect(await seen(DESKTOP)).toBe("other");
		await claim;
		expect(await later).toMatchObject([{ cols: 100 }]);
		expect(await resize(PHONE, 60)).toMatchObject([{ cols: 60 }]);
		expect(await seen(PHONE)).toBe("you");
		await request(DESKTOP, { action: "claim", id });
		expect(await seen(PHONE)).toBe("other");
	});

	it("an absent holder gives way at ten seconds; an idle but present holder gives way to a typist at fifteen", async () => {
		await resize(DESKTOP, 100);
		now += 9999;
		expect(await seen(PHONE)).toBe("other");
		now++;
		expect(await seen(PHONE)).toBe("free");
		await request(PHONE, { action: "write", id, data: "a" });
		now += 8000;
		expect(await seen(PHONE)).toBe("you");
		now += 6999;
		await request(DESKTOP, { action: "write", id, data: "b" });
		expect(await seen(DESKTOP)).toBe("other");
		now++;
		await request(DESKTOP, { action: "write", id, data: "\ud800" });
		expect(await seen(DESKTOP)).toBe("you");
		expect(await request(DESKTOP, { action: "list" })).toMatchObject([{ output: "ab\ud800" }]);
	});

	it("a close forgets one terminal; releasing an owner forgets its other terminals but not another owner's", async () => {
		const sessions = await request(DESKTOP, { action: "create", cols: 80, rows: 24 });
		const sibling = sessions.find(session => session.id !== id)!;
		const other = "3:else";
		const [unrelated] = await request(DESKTOP, { action: "create", cols: 80, rows: 24 }, other);
		await request(DESKTOP, { action: "claim", id });
		await request(DESKTOP, { action: "claim", id: sibling.id });
		await request(PHONE, { action: "claim", id: unrelated.id }, other);
		await request(DESKTOP, { action: "close", id });
		expect(await seen(DESKTOP)).toBe("free");
		expect(await seen(DESKTOP, owner, sibling.id)).toBe("you");
		await helper.request("terminal.dispose", { owner });
		expect(await seen(DESKTOP, owner, sibling.id)).toBe("free");
		expect(await seen(PHONE, other, unrelated.id)).toBe("you");
	});
});
