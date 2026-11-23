import { createReadStream } from "node:fs";
import { open, readdir, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import { cookieLoads, integer, type NetTrace, readNet } from "./nav-stages-net";

const nativeFields = new Map<string, string[]>(
	Object.entries({
		"shell.started": ["at"],
		"shell.ended": ["code"],
		exit: ["code"],
		"shell.handedOver": [],
		"shell.failed": [],
		"exit.requested": ["code", "forwardedToNode"],
		"node.gone": ["code", "via", "quitting"],
		"profile.migrate": ["wcId", "step", "attempt"],
		"profile.migrate.navigation": ["wcId", "allowed"],
		"profile.migrate.stalled": ["wcId", "step", "waitedMs", "retry"],
		"profile.migrate.gave_up": ["wcId", "step"],
		"profile.migrate.request": ["wcId"],
		"profile.migrate.refused": ["wcId"],
		"profile.migrate.failed": ["wcId"],
		"profile.migrate.retry_failed": ["wcId"],
		"profile.migrate.dispatch_failed": ["wcId"],
		"probe.nav.watching": ["wc"],
		"probe.nav.failed": [],
		"probe.nav.resource": ["wc"],
		"probe.nav.response": ["wc", "status"],
		"probe.nav.start": ["wc", "id", "kind", "cancelled"],
		"probe.nav.end": ["wc", "id", "ok", "error"],
	}),
);
const enums: Record<string, string[]> = {
	step: ["navigate", "served", "loading", "loaded", "read", "handover", "app"],
	via: ["closed", "exited"],
	kind: ["blank", "other", "bootstrap"],
};
type Native = {
	event: string;
	t: number;
	wc?: number | null;
	id?: number | null;
	attempt?: number | null;
	at?: number | null;
	kind?: string | null;
	step?: string | null;
	ok?: boolean | null;
	error?: number | null;
};

function nativeRow(line: string): Native | null {
	const input = JSON.parse(line);
	const t = integer(input?.t),
		keys = nativeFields.get(input?.event);
	if (t === null || !keys) return null;
	const fields: Record<string, string | number | boolean | null> = {};
	for (const key of keys) {
		const v = input[key];
		fields[key === "wcId" ? "wc" : key] = enums[key]
			? enums[key].includes(v)
				? v
				: null
			: ["ok", "allowed", "cancelled", "quitting", "forwardedToNode"].includes(key)
				? typeof v === "boolean"
					? v
					: null
				: integer(v);
	}
	return { event: input.event, t, ...fields };
}

type Attempt = {
	wc: number;
	attempt: number | null;
	dispatchT: number | null;
	startT: number | null;
	stopT: number | null;
	navId: number | null;
	ok: boolean | null;
	webErrorStatus: number | null;
};

function attempts(rows: Native[]): Attempt[] {
	const result: Attempt[] = [],
		latest = new Map<number, Attempt>(),
		byId = new Map<string, Attempt>();
	for (const row of rows) {
		const wc = row.wc;
		if (wc == null) continue;
		const dispatch = row.event === "profile.migrate" && row.step === "navigate";
		const start = row.event === "probe.nav.start" && row.kind === "bootstrap";
		if (dispatch || start) {
			let attempt = latest.get(wc);
			if (dispatch || !attempt || attempt.startT !== null) {
				attempt = {
					wc,
					attempt: row.attempt ?? null,
					dispatchT: dispatch ? row.t : null,
					startT: null,
					stopT: null,
					navId: null,
					ok: null,
					webErrorStatus: null,
				};
				result.push(attempt);
				latest.set(wc, attempt);
			}
			if (start) {
				attempt.startT = row.t;
				attempt.navId = row.id ?? null;
				if (row.id != null) byId.set(`${wc}:${row.id}`, attempt);
			}
		} else if (row.event === "probe.nav.end" && row.id != null) {
			const attempt = byId.get(`${wc}:${row.id}`);
			if (attempt) {
				attempt.stopT = row.t;
				attempt.ok = row.ok ?? null;
				attempt.webErrorStatus = row.error ?? null;
			}
		}
	}
	return result;
}

export function summarize(native: Native[], net: NetTrace, nativeState: string): object[] {
	native.sort((a, b) => a.t - b.t);
	const start = native.find(r => r.event === "shell.started");
	const epoch = start?.at == null ? null : start.at - start.t;
	const stages = attempts(native),
		loads = cookieLoads(net);
	const output: object[] = [...native];
	for (const [source, at] of net.bootstrap)
		output.push({ event: "network.bootstrap", source, at, t: at === null || epoch === null ? null : at - epoch });
	for (const phase of net.phases)
		output.push({
			event: "network.phase",
			...phase,
			t: phase.at === null || epoch === null ? null : phase.at - epoch,
		});
	for (const [index, stage] of stages.entries()) {
		// These loads are shared host observations, not requests made by this navigation. A negative delta is expected on retry.
		const nav = stage.startT ?? stage.dispatchT;
		const anchor = nav === null || epoch === null ? null : epoch + nav;
		const from = stage.dispatchT ?? nav;
		const next = stages.find((row, i) => i > index && row.wc === stage.wc);
		const until = Math.min(stage.stopT ?? Infinity, next?.dispatchT ?? next?.startT ?? Infinity);
		// NetLog has no WebView2 navigation ID. Concurrent windows can list the same candidate.
		const candidateSources =
			epoch === null || from === null || !net.clock
				? null
				: [...net.bootstrap]
						.filter(([, at]) => at !== null && at - epoch >= from && at - epoch <= until)
						.map(([source]) => source);
		output.push({
			event: "bootstrap.attempt",
			...stage,
			anchor: stage.startT === null ? "dispatch" : "native",
			candidateSources,
			cookieLoads: loads.map(({ source, beginAt, endAt }) => ({
				source,
				beginFromNavMs: beginAt === null || anchor === null ? null : beginAt - anchor,
				endFromNavMs: endAt === null || anchor === null ? null : endAt - anchor,
			})),
		});
	}
	output.push({
		event: "host.summary",
		nativeState,
		netState: net.state,
		netClock: net.clock,
		started: !!start,
		endedT: native.find(r => r.event === "shell.ended")?.t ?? null,
		dispatchOrStartCount: stages.length,
		nativeStopCount: stages.filter(r => r.stopT !== null).length,
		bootstrapSourceCount: net.bootstrap.size,
		cookieLoadCount: loads.length,
	});
	return output;
}

const lines = (file: string) =>
	createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
async function directory(env: string): Promise<string> {
	const path = process.env[env];
	if (!path || !isAbsolute(path)) throw new Error("invalid probe directory");
	return realpath(path);
}

async function main(): Promise<void> {
	const [raw, out] = await Promise.all([directory("OMPDESK_NAV_PRIVATE"), directory("OMPDESK_NAV_STAGES")]);
	for (const rel of [relative(raw, out), relative(out, raw)]) {
		if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("overlapping directories");
	}
	const hosts = new Map<string, { native?: string; net?: string }>();
	for (const file of await readdir(raw, { withFileTypes: true })) {
		if (!file.isFile()) continue;
		const match = /^(native|net)-(\d{1,10}-\d{1,15})\.(jsonl|json)$/.exec(file.name);
		if (!match || (match[1] === "native") !== (match[3] === "jsonl")) continue;
		const host = hosts.get(match[2]) ?? {};
		if (match[1] === "native") host.native = file.name;
		else host.net = file.name;
		hosts.set(match[2], host);
	}
	const temp = join(out, `navigation-${process.pid}-${Date.now()}.jsonl`);
	const output = await open(temp, "wx");
	try {
		for (const [key, files] of hosts) {
			const [pid, lifetime] = key.split("-").map(Number);
			const native: Native[] = [];
			let state = "missing";
			if (files.native) {
				state = "read";
				try {
					for await (const line of lines(join(raw, files.native))) {
						try {
							const row = nativeRow(line);
							if (row) native.push(row);
							else state = "partial";
						} catch {
							state = "partial";
						}
					}
				} catch {
					state = "unreadable";
				}
			}
			const net = await readNet(files.net ? lines(join(raw, files.net)) : []);
			if (!files.net) net.state = "missing";
			const rows = summarize(native, net, state);
			await output.writeFile(`${rows.map(row => JSON.stringify({ pid, lifetime, ...row })).join("\n")}\n`);
		}
		await output.writeFile(`${JSON.stringify({ event: "collection.summary", hosts: hosts.size })}\n`);
	} finally {
		await output.close();
	}
	await rename(temp, join(out, "navigation.jsonl"));
	if (!hosts.size) throw new Error("no host records");
}

if (import.meta.main)
	main().catch(() => {
		console.error("Navigation stage collection incomplete.");
		process.exitCode = 1;
	});
