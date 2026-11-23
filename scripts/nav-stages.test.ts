import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const run = promisify(execFile);

test("interrupted NetLog retains shared cookie timing, independent navigation outcomes and only allowed fields", async () => {
	const root = await mkdtemp(join(tmpdir(), "nav-stages-"));
	const raw = join(root, "private"),
		out = join(root, "stages");
	const secret = "never-export-this";
	try {
		await Promise.all([mkdir(raw), mkdir(out)]);
		const native = [
			{ event: "shell.started", at: 1004, t: 4, pid: 7, argv: [secret] },
			{ event: "profile.migrate", wcId: 1, step: "navigate", attempt: 1, t: 5 },
			{ event: "probe.nav.start", wc: 1, kind: "bootstrap", id: 9, t: 10 },
			{ event: "profile.migrate", wcId: 1, step: "navigate", attempt: 2, t: 20 },
			{ event: "probe.nav.start", wc: 1, kind: "bootstrap", id: 10, t: 21 },
			{ event: "probe.nav.end", wc: 1, id: 9, t: 22, ok: false, error: 14 },
			{ event: "profile.migrate.gave_up", wcId: 1, step: secret, reason: secret, t: 30 },
		];
		await writeFile(join(raw, "native-7-1000.jsonl"), `${native.map(row => JSON.stringify(row)).join("\n")}\n{`);
		await writeFile(join(raw, "native-7-5000.jsonl"), JSON.stringify({ event: "shell.started", at: 5000, t: 0 }));
		const constants = {
			timeTickOffset: "1000",
			clientInfo: { command_line: secret },
			logEventTypes: {
				COOKIE_PERSISTENT_STORE_LOAD: 1,
				URL_REQUEST_START_JOB: 2,
				PROXY_RESOLUTION_SERVICE_WAITING_FOR_INIT_PAC: 3,
			},
		};
		const event = (type: number, id: number, phase: number, time: number, params = {}) =>
			JSON.stringify({ type, source: { id }, phase, time: String(time), params });
		const net = [
			`{"constants":${JSON.stringify(constants)},`,
			'"events": [',
			event(1, 51, 1, 8),
			event(2, 33, 1, 11, { url: `http://app.localhost/__profile/migrate?${secret}` }),
			event(3, 33, 1, 12, { secret }),
			event(3, 87, 1, 13, { secret }),
			event(1, 51, 2, 26),
		];
		await writeFile(
			join(raw, "net-7-1000.json"),
			`${net.slice(0, 2).join("\n")}\n${net.slice(2).join(",\n")},\n{"type":`,
		);
		await writeFile(
			join(raw, "net-9-6000.json"),
			`${net.slice(0, 2).join("\n")}\n${event(1, 60, 2, 33)}],\n"polledData": {"ignored":"${secret}"}\n}\n`,
		);
		await run("bun", ["scripts/nav-stages.ts"], {
			env: { ...process.env, OMPDESK_NAV_PRIVATE: raw, OMPDESK_NAV_STAGES: out },
		});
		const text = await readFile(join(out, "navigation.jsonl"), "utf8");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("app.localhost");
		const rows = text
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(rows.filter(r => r.event === "bootstrap.attempt")).toMatchObject([
			{
				pid: 7,
				lifetime: 1000,
				attempt: 1,
				navId: 9,
				stopT: 22,
				ok: false,
				webErrorStatus: 14,
				candidateSources: [33],
				cookieLoads: [{ source: 51, beginFromNavMs: -2, endFromNavMs: 16 }],
			},
			{
				pid: 7,
				lifetime: 1000,
				attempt: 2,
				navId: 10,
				stopT: null,
				ok: null,
				webErrorStatus: null,
				candidateSources: [],
				cookieLoads: [{ source: 51, beginFromNavMs: -13, endFromNavMs: 5 }],
			},
		]);
		expect(rows.filter(r => r.name === "PROXY_RESOLUTION_SERVICE_WAITING_FOR_INIT_PAC")).toMatchObject([
			{ source: 33, phase: 1, t: 12 },
		]);
		expect(rows.find(r => r.event === "host.summary" && r.lifetime === 1000)).toMatchObject({
			netState: "partial",
			nativeState: "partial",
			endedT: null,
		});
		expect(rows.find(r => r.event === "host.summary" && r.lifetime === 5000)).toMatchObject({
			netState: "missing",
			cookieLoadCount: 0,
		});
		expect(rows.find(r => r.event === "host.summary" && r.pid === 9)).toMatchObject({
			nativeState: "missing",
			netState: "closed",
			started: false,
		});
		expect(rows.find(r => r.event === "network.phase" && r.pid === 9)).toMatchObject({
			source: 60,
			at: 1033,
			t: null,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
