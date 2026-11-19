import { existsSync, readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
	atEnd,
	CLEANUP_MS,
	type Frame,
	HOLD,
	type Omp,
	type Provider,
	runCleanups,
	sessionFiles,
	startOmp,
	startProvider,
} from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

afterAll(runCleanups, CLEANUP_MS);

/**
 * What the composer's own commands do on the installed omp, with a scripted OpenAI-compatible provider on loopback
 * (no model spend): `!` and `!!` (user bash), `$` and `$$` (user python), taking a queued message back, and Esc during
 * a manual compaction. Each case sends what main sends (`src/main/local/composer.ts`, `queue.ts`): a stock RPC frame
 * or the bridge method, and reads what the person and the model then get.
 */
async function open(options?: { holdSide?: string }): Promise<{ provider: Provider; session: Omp }> {
	const provider = await startProvider(options);
	atEnd(() => provider.close());
	return { provider, session: await startOmp(provider) };
}

const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;

/** Sends `message` as a prompt, waits for its turn to end and returns the body of the model request that carried it. */
async function ask(session: Omp, provider: Provider, message: string): Promise<string> {
	const turns = ended(session.frames);
	await session.send({ type: "prompt", message });
	await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(turns + 1);
	const body = provider.bodies.at(-1) ?? "";
	expect(body).toContain(message);
	return body;
}

/** The composer's queue chips: stock's newest `queue_update`. */
function chips(frames: readonly Frame[]): { steering?: string[]; followUp?: string[] } {
	const { steering, followUp } = frames.findLast(frame => frame.type === "queue_update") ?? {};
	return { steering, followUp };
}

/** A turn held at the provider with `texts` queued behind it as follow-ups, oldest first. */
async function heldWithQueue(texts: string[]): Promise<{ provider: Provider; session: Omp }> {
	const { provider, session } = await open();
	await session.send({ type: "prompt", message: HOLD });
	await provider.held;
	for (const message of texts) await session.send({ type: "follow_up", message });
	await expect.poll(() => chips(session.frames), { timeout: 15_000 }).toEqual({ steering: [], followUp: texts });
	return { provider, session };
}

/** Stock reports nothing running and nothing queued: no further model request can follow. */
const settled = (session: Omp) =>
	expect
		.poll(() => session.send({ type: "get_state" }), { timeout: 30_000 })
		.toMatchObject({ data: { isSettled: true } });

function journal(session: Omp): Array<{ type?: string }> {
	return sessionFiles(session.isolated).flatMap(file =>
		readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { type?: string }),
	);
}

describe.skipIf(!existsSync(omp))("the composer's commands on stock omp", () => {
	// Each command prints a value it computes, so the text read back is its output, never the typed line.
	it("! runs the command, and the model reads its output with the next prompt", async () => {
		const { provider, session } = await open();
		expect(await session.send({ type: "bash", command: "echo ok-$((6 * 7))" })).toMatchObject({
			success: true,
			data: { output: expect.stringContaining("ok-42"), exitCode: 0 },
		});
		expect(await ask(session, provider, "after the command")).toContain("ok-42");
	}, 180_000);

	it("!! runs the command and keeps it out of what the model reads", async () => {
		const { provider, session } = await open();
		expect(
			await session.bridge.request("composer.bash_excluded", { command: "echo kept-out-$((6 * 7))" }),
		).toMatchObject({ output: expect.stringContaining("kept-out-42"), exitCode: 0 });
		// A plain `!` beside it: the request below is one that carries user bash.
		await session.send({ type: "bash", command: "echo shared-$((6 * 7))" });
		const body = await ask(session, provider, "after both commands");
		expect(body).toContain("shared-42");
		expect(body).not.toContain("kept-out");
	}, 180_000);

	// Needs a Python on PATH, as the `$` mode itself does (stock: "Python executable not found on PATH").
	it("$ prints the value and the model reads it; $$ keeps it out", async () => {
		const { provider, session } = await open();
		expect(
			await session.bridge.request("composer.eval", { code: 'print("shared-" + str(6 * 7))', excluded: false }),
		).toMatchObject({ output: expect.stringContaining("shared-42"), exitCode: 0, cancelled: false });
		expect(
			await session.bridge.request("composer.eval", { code: 'print("kept-out-" + str(6 * 7))', excluded: true }),
		).toMatchObject({ output: expect.stringContaining("kept-out-42"), exitCode: 0, cancelled: false });
		const body = await ask(session, provider, "after both cells");
		expect(body).toContain("shared-42");
		expect(body).not.toContain("kept-out");
	}, 180_000);

	it("takes the newest queued message back: its chip goes, the model never reads it, the older one still runs", async () => {
		const { provider, session } = await heldWithQueue(["queued-A", "queued-B"]);
		expect(await session.bridge.request("composer.dequeue")).toMatchObject({ text: "queued-B", mode: "followUp" });
		await expect
			.poll(() => chips(session.frames), { timeout: 15_000 })
			.toEqual({ steering: [], followUp: ["queued-A"] });
		provider.release();
		await expect.poll(() => provider.bodies.some(body => body.includes("queued-A")), { timeout: 30_000 }).toBe(true);
		await settled(session);
		expect(provider.bodies.some(body => body.includes("queued-B"))).toBe(false);
	}, 180_000);

	it("takes queued messages back newest first until none is left, and none of them runs", async () => {
		const { provider, session } = await heldWithQueue(["queued-A", "queued-B"]);
		expect(await session.bridge.request("composer.dequeue")).toMatchObject({ text: "queued-B", mode: "followUp" });
		expect(await session.bridge.request("composer.dequeue")).toMatchObject({ text: "queued-A", mode: "followUp" });
		expect(await session.bridge.request("composer.dequeue")).toBeNull();
		await expect.poll(() => chips(session.frames), { timeout: 15_000 }).toEqual({ steering: [], followUp: [] });
		provider.release();
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		await settled(session);
		expect(provider.turns).toBe(1);
	}, 180_000);

	it("Esc during a manual compaction cancels it: the conversation stays whole and the next prompt runs", async () => {
		const mark = "COMPACT-MARK";
		const { provider, session } = await open({ holdSide: mark });
		// Stock summarizes only what does not fit its kept tail (20 000 tokens), so the first prompt is larger than it.
		await ask(session, provider, `${mark} ${"lorem ipsum dolor sit amet ".repeat(8_000)}`);
		const compacting = session.send({ type: "compact" });
		// The summary request is at the provider and stays unanswered: only the cancel can end this compaction.
		await provider.held;
		expect(await session.bridge.request("composer.abort_maintenance")).toBeNull();
		expect(await compacting).toMatchObject({ success: false });
		await expect
			.poll(() => session.frames.find(frame => frame.type === "manual_compaction_end"), { timeout: 15_000 })
			.toMatchObject({ aborted: true });
		expect(journal(session).some(entry => entry.type === "compaction")).toBe(false);
		expect(await ask(session, provider, "after the cancelled compaction")).toContain(mark);
	}, 180_000);
});
