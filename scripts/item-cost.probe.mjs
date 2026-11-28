// Run scripts/item-cost.sh on Linux CI. Counts the bytes the endpoints read, not JSON re-encoded by the probe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Duplex, PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "vitest";
import { stopCore } from "../src/main/core/process";
import { configureNativeBin } from "../src/main/native-bin";
import { ShellClient } from "../src/main/shell-host/client";
import { channels as ch, peerEndpoint, windowEndpoint } from "./item-cost-endpoints.mjs";
import { comment, detail, feed, fixture, target } from "./item-cost-fixture.mjs";
import { fileIo, traceArgs } from "./item-cost-io.mjs";

const root = process.env.OMPDESK_ITEM_COST_ROOT;
const modes = ["v1", "modern", "inspector", "legacy-peer", "v1-remote", "modern-remote", "legacy-peer-remote"];

async function until(promise, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), 20_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function rawFrames(chunks) {
	const bytes = Buffer.concat(chunks);
	const frames = [];
	for (let pos = 0; pos < bytes.length; ) {
		const end = bytes.indexOf(10, pos);
		assert(end >= pos, "partial core frame at measurement boundary");
		const obj = JSON.parse(bytes.toString("utf8", pos, end));
		assert(!obj.bin, "unexpected binary frame in item service");
		frames.push([obj, end - pos + 1]);
		pos = end + 1;
	}
	return frames;
}

function coreFrames(outgoing, incoming) {
	const received = rawFrames(incoming);
	const asks = new Map(received.filter(([f]) => f.data?.ask !== undefined).map(([f]) => [f.data.ask, f.data.method]));
	const calls = new Map();
	const coreRx = rawFrames(outgoing).map(([f, bytes]) => {
		const op = f.method === "ports.answer" ? `answer:${asks.get(f.params.ask)}` : (f.params?.method ?? f.method);
		calls.set(f.id, op);
		return [op, bytes];
	});
	const coreTx = received.map(([f, bytes]) => [f.data?.method ?? f.event ?? `reply:${calls.get(f.id)}`, bytes]);
	return { coreRx, coreTx };
}

// Read the closed profile after tracing. These are durable row counts, not SQLite I/O estimates.
function stored(dir, old, f, history) {
	let events, targetEvents;
	if (old) {
		const rows = JSON.parse(readFileSync(f.files.items));
		assert.equal(rows.length, f.items);
		const row = rows.find(r => r.id === target);
		assert.equal(row.version, 11);
		assert.equal(row.events.at(-1).request, comment.requestId);
		targetEvents = row.events.length;
		events = rows.reduce((n, r) => n + r.events.length, 0);
	} else {
		const db = new DatabaseSync(join(dir, "items.sqlite3"), { readOnly: true });
		try {
			const count = (tail, ...args) => db.prepare(`SELECT count(*) AS n FROM ${tail}`).get(...args).n;
			assert.equal(count("item"), f.items);
			assert.equal(count("item WHERE id = ? AND json_extract(current_json,'$.version') = 11", target), 1);
			assert.equal(count("item_event WHERE item = ? AND request = ?", target, comment.requestId), 1);
			assert.equal(count("item_mail"), 0, "mail not acknowledged");
			targetEvents = count("item_event WHERE item = ?", target);
			events = count("item_event");
		} finally {
			db.close();
		}
	}
	// The historical writer drops all but 50 on the first edit of the oversized target.
	assert.equal(targetEvents, old ? Math.min(history + 1, 50) : history + 1);
	assert.equal(events, f.events - history + targetEvents);
	return { events, targetEvents };
}

function checkedDelta(delta, version) {
	assert.equal(delta.kind, "delta");
	assert.equal(delta.base, version);
	assert.deepEqual(
		delta.set.map(row => row.id),
		[target],
	);
	assert.equal(delta.set[0].version, 11);
	assert.deepEqual(delta.remove, []);
	assert(!Object.hasOwn(delta.set[0], "events"));
}

async function measure(scale, mode, trace) {
	const old = mode.startsWith("v1");
	const oldPeer = old || mode.startsWith("legacy-peer");
	const remote = mode.endsWith("-remote");
	const inspector = mode === "inspector";
	const dir = mkdtempSync(join(root, "sample-"));
	const f = fixture(dir, scale);
	const binary = join(root, old ? "baseline" : "ompdesk-bin", "ompdesk-core");
	const args = trace ? [...traceArgs(join(dir, "syscalls")), binary] : [];
	const child = spawn(trace ? "strace" : binary, args, { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
	const exit = once(child, "exit");
	const input = new PassThrough();
	input.pipe(child.stdin);
	const rpc = new ShellClient(Duplex.from({ readable: child.stdout, writable: input }));
	const call = (method, args) => rpc.call("agentControl.call", { port: 1, method, args });
	let capture = false;
	const incoming = [],
		outgoing = [];
	child.stdout.on("data", chunk => {
		if (capture) incoming.push(chunk);
	});
	input.on("data", chunk => {
		if (capture) outgoing.push(chunk);
	});
	const digest = Promise.withResolvers();
	let window,
		peer,
		mail = [],
		told = [],
		audience = Promise.resolve();
	const askErrors = [];
	const replies = new Set();
	rpc.on("port", d => {
		if (d.ask !== undefined) {
			let value;
			if (d.method === "mail") {
				mail.push(d.args.details);
				value = { duplicate: false, journaled: true, itemSession: d.args.details.itemSession };
			} else if (d.method === "command") value = { success: true };
			else if (d.method === "state") value = null;
			else askErrors.push(`unexpected host ask ${d.method}`);
			const answered = rpc.call("ports.answer", { port: 1, ask: d.ask, ok: value !== undefined, value });
			replies.add(answered);
			void answered.then(
				() => {
					replies.delete(answered);
					if (d.args?.command?.type === "agent_control_bot") digest.resolve();
				},
				error => askErrors.push(String(error)),
			);
		} else {
			told.push(d.method);
			if (d.method === "botsChanged") window?.legacy(d.args.state);
			if (d.method === "botsShared") peer?.services.botsChanged(d.args.change);
			if (d.method === "itemsV2Changed") {
				window?.changed();
				peer?.services.itemsV2Changed();
			}
		}
	});
	try {
		await rpc.call("agentControl.open", { port: 1, files: f.files, state: f.state });
		await call("bots", { action: "item", id: "item-000002", status: "working", note: "x".repeat(420) });
		await until(digest.promise, `${scale}/${mode}: warm bot context`);
		const windowNotices = [],
			peerNotices = [];
		let windowWake, peerWake;
		window = await windowEndpoint(call, (channel, payload) => {
			windowNotices.push([channel, payload]);
			windowWake?.resolve();
		});
		peer = await peerEndpoint(
			call,
			(event, payload) => {
				peerNotices.push([event, payload]);
				peerWake?.resolve();
			},
			old ? null : active => (audience = call("itemsLegacyAudience", { local: false, peer: active })),
		);
		const localRead = q => window.invoke(ch.ITEMS_V2_QUERY, null, q);
		const peerRead = q => peer.invoke(ch.ITEMS_V2_METHOD, q);
		const negotiate = async () => {
			const local = old ? await window.invoke(ch.BOTS_COMMAND, { action: "get" }) : await localRead(feed);
			const paired = oldPeer ? await peer.invoke("host.bots.list", {}) : await peerRead(feed);
			assert.equal(old ? local.items.length : local.open.length, old ? f.items : f.open);
			assert.equal(oldPeer ? paired.state.items.length : paired.open.length, oldPeer ? f.items : f.open);
			if (inspector) {
				const opened = await localRead(detail);
				assert.equal(opened.events.at(-1).id, f.cursor);
			}
			return [local.version, paired.version];
		};
		capture = true;
		const [nativeVer, peerVer] = await until(negotiate(), `${scale}/${mode}: negotiate`);
		await audience;
		await Promise.all(replies);
		const boundary = (before, peerAt) => {
			const [rxBytes, txBytes, rxFrames, txFrames] = window.counters().map((n, i) => n - before[i]);
			return {
				ipc: { rxBytes, txBytes, rxFrames, txFrames },
				...coreFrames(outgoing, incoming),
				peer: peer.traffic.slice(peerAt),
			};
		};
		const seed = boundary([0, 0, 0, 0], 0);
		incoming.length = outgoing.length = 0;
		const beforeRecovery = window.counters(),
			peerAt = peer.traffic.length;
		if (!old) assert.equal((await localRead({ ...feed, since: "lost.0" })).kind, "seed");
		else assert.equal((await window.invoke(ch.BOTS_COMMAND, { action: "get" })).items.length, f.items);
		if (!oldPeer) assert.equal((await peerRead({ ...feed, since: "lost.0" })).kind, "seed");
		else assert.equal((await peer.invoke("host.bots.list", {})).state.items.length, f.items);
		const recovery = boundary(beforeRecovery, peerAt);
		incoming.length = outgoing.length = 0;
		windowNotices.length = peerNotices.length = peer.traffic.length = mail.length = told.length = 0;
		windowWake = Promise.withResolvers();
		peerWake = Promise.withResolvers();
		const before = window.counters();
		if (trace) await delay(5); // Separate setup syscalls from Date.now()'s millisecond boundary.
		const start = Date.now() / 1000;
		const began = performance.now();
		const receipt = await until(
			remote
				? peer.invoke(
						oldPeer ? "host.bots.command" : ch.ITEMS_CHANGE_METHOD,
						oldPeer ? { request: comment } : comment,
					)
				: old
					? window.invoke(ch.BOTS_COMMAND, comment)
					: window.invoke(ch.ITEMS_V2_CHANGE, null, comment),
			`${scale}/${mode}: mutation`,
		);
		const replyMs = performance.now() - began;
		await until(Promise.all([windowWake.promise, peerWake.promise]), `${scale}/${mode}: committed notices`);
		if (old || (remote && oldPeer)) {
			const rows = (remote ? receipt.state : receipt).items;
			assert.equal(rows.length, f.items);
			assert.equal(rows.find(r => r.id === target).events.at(-1).request, comment.requestId);
		} else assert.deepEqual(receipt, {});
		if (!old) checkedDelta(await localRead({ ...feed, since: nativeVer }), nativeVer);
		if (!oldPeer) checkedDelta(await peerRead({ ...feed, since: peerVer }), peerVer);
		if (inspector) {
			const after = await localRead({ ...detail, afterEvent: f.cursor });
			assert.equal(after.events.length, 1);
			assert.equal(after.events[0].request, comment.requestId);
			assert.equal(after.events[0].text, comment.comment);
		}
		await Promise.all(replies);
		const deliveryMs = performance.now() - began;
		capture = false;
		const end = (Date.now() + 1) / 1000;
		if (trace) await delay(5); // Postcondition reads and process shutdown aren't part of the warm write.
		const warm = boundary(before, 0);
		assert.deepEqual(
			windowNotices.map(([name]) => name),
			[old ? ch.BOTS_STATE : ch.ITEMS_V2_CHANGED],
		);
		assert.deepEqual(
			peerNotices.map(([name]) => name),
			[oldPeer ? ch.BOTS_EVENT : ch.PEER_CHANGED],
		);
		if (oldPeer) assert.equal(peerNotices[0][1].set.items[0].events.at(-1).request, comment.requestId);
		assert.equal(mail.length, 1);
		assert(mail[0].text.includes(comment.comment));
		assert.deepEqual(askErrors, []);
		if (!old) assert(!told.includes("botsChanged"));
		if (!oldPeer) assert(!told.includes("botsShared"));
		const { coreRx, coreTx, ipc } = warm;
		const bytes = frames => frames.reduce((n, frame) => n + frame.at(-1), 0);
		const totals = { ipc: ipc.rxBytes + ipc.txBytes, peer: bytes(warm.peer), port: bytes(coreRx) + bytes(coreTx) };
		assert.equal(coreTx.filter(([op]) => op === "mail").length, 1);
		const mailPortBytes =
			bytes(coreTx.filter(([op]) => op === "mail" || op === "reply:answer:mail")) +
			bytes(coreRx.filter(([op]) => op === "answer:mail"));
		assert.equal(coreRx.filter(([op]) => op === "answer:mail").length, 1);
		if (!oldPeer)
			assert.equal(coreTx.filter(([op]) => op === "command").length, 0, "plain comment resent bot context");
		if (!oldPeer)
			for (const [boundary, n] of Object.entries(totals)) assert(n < 16_384, `${boundary} full payload: ${n}`);
		// Verify retention *after* timing; the client without an inspector didn't read any detail to deliver the change.
		if (!old) {
			const read = await localRead({ ...detail, afterEvent: f.cursor });
			assert.deepEqual(
				read.events.map(e => e.request),
				[comment.requestId],
			);
		}
		const sample = {
			scale,
			mode,
			items: f.items,
			events: f.events,
			traced: trace,
			replyMs,
			deliveryMs,
			seed,
			recovery,
			...warm,
			totals,
			mailPortBytes,
		};
		peer.close();
		peer = undefined;
		window.close();
		window = undefined;
		child.stdin.end();
		assert.equal((await until(exit, "flush syscall trace"))[0], 0);
		return {
			...sample,
			stored: stored(dir, old, f, scale === "history-x10" ? 180 : 18),
			fileSyscalls: trace ? fileIo(dir, start, end) : null,
		};
	} finally {
		peer?.close();
		window?.close();
		child.stdin.end();
		rpc.close();
		try {
			await until(exit, "core exit");
		} finally {
			child.kill();
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

it.skipIf(!root)(
	"measures one committed item comment through a native window and a connected device",
	async () => {
		assert.equal(process.platform, "linux");
		configureNativeBin({ packaged: true, resourcesPath: root });
		const spread = values => {
			const v = [...values].sort((a, b) => a - b);
			return [v[0], v[Math.floor(v.length / 2)], v.at(-1)];
		};
		const base = new Map();
		try {
			for (const scale of ["base", "unrelated-x10", "history-x10"]) {
				const samples = new Map(modes.map(mode => [mode, []]));
				for (let rep = 0; rep < 6; rep++) {
					for (const mode of rep % 2 ? [...modes].reverse() : modes) {
						const r = await measure(scale, mode, rep === 5);
						console.log("ITEM_COST_SAMPLE", JSON.stringify(r));
						if (rep < 5) samples.get(mode).push(r);
						else if (mode.startsWith("v1")) {
							const written = Object.entries(r.fileSyscalls)
								.filter(([file]) => /^items\.json\..+\.tmp$/.test(file))
								.reduce((n, [, calls]) => n + calls.writeBytes, 0);
							assert(written >= 420 * (r.events - 180), "v1 positive control did not rewrite item histories");
						} else {
							assert(r.fileSyscalls["items.sqlite3"]?.writeBytes > 0, "no SQLite commit observed");
							const { readBytes = 0, writeBytes = 0 } = r.fileSyscalls["items.json"] ?? {};
							assert.equal(readBytes + writeBytes, 0, "warm host reopened or rewrote the legacy payload");
							const io = Object.values(r.fileSyscalls).reduce((n, f) => n + f.readBytes + f.writeBytes, 0);
							assert(io < 256 * 1024, `storage scaled with whole store: ${io} bytes`);
							if (scale === "base") base.set(`io:${mode}`, io);
							else
								assert(
									io <= base.get(`io:${mode}`) + 96 * 1024,
									`${scale}/${mode}: excessive additional page I/O: ${io}`,
								);
						}
					}
				}
				for (const [mode, runs] of samples) {
					const summary = {
						scale,
						mode,
						runs: runs.length,
						minMedianMaxReplyMs: spread(runs.map(r => r.replyMs)),
						minMedianMaxDeliveryMs: spread(runs.map(r => r.deliveryMs)),
						minMedianMaxBytes: Object.fromEntries(
							Object.keys(runs[0].totals).map(k => [k, spread(runs.map(r => r.totals[k]))]),
						),
					};
					console.log("ITEM_COST_SUMMARY", JSON.stringify(summary));
					if (scale === "base") base.set(mode, runs[0].totals);
					if (["modern", "inspector", "modern-remote"].includes(mode))
						for (const run of runs)
							for (const [boundary, n] of Object.entries(run.totals))
								assert(n <= base.get(mode)[boundary] + 256, `${scale} ${mode} ${boundary}: ${n}`);
				}
			}
		} finally {
			await stopCore();
		}
	},
	300_000,
);
