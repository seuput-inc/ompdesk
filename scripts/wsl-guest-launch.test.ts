import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const bridgeDir = join(__dirname, "../resources/gui-bridge");
const launch = join(bridgeDir, "wsl/launch.ts");
const linux = process.platform === "linux";
const homes: string[] = [];
const runtime = linux ? `/run/user/${process.getuid!()}` : "";
const id = () => randomBytes(16).toString("hex");
const basename = "synthetic-session.jsonl";

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
	const home = mkdtempSync(join(linux && existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "omp-wsl-launch-"));
	homes.push(home);
	const cwd = join(home, "project");
	const sessionDir = join(home, "assigned sessions");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	const env = {
		HOME: home,
		USERPROFILE: home,
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		WSLENV: "WSL_PROOF_SENTINEL",
		WSL_PROOF_SENTINEL: "host-only",
		INVOCATION_ID: id(), // Protocol fixture only. The host must match the ID against the real service.
		PI_CODING_AGENT_DIR: "/must-not-be-forwarded",
		OMP_GUI_BRIDGE: "host-pipe",
	};
	const request = { spawnId: id(), tabTag: id(), cwd, sessionDir, bridgeDir, minimumOmpVersion: "19.2.0" };
	return { home, env, request, options: { cwd: home, env, timeout: 5000 } };
}

interface Fixture {
	home: string;
	request: { spawnId: string };
	options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number };
}
function install(f: Fixture, version = "19.2.0", engine = ">=1.0.0") {
	const pkg = join(f.home, ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent");
	mkdirSync(join(pkg, "dist"), { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version, engines: { bun: engine } }),
		{ mode: 0o600 },
	);
	writeFileSync(
		join(pkg, "dist/cli.js"),
		`
		import { statSync } from "node:fs";
		import { dirname } from "node:path";
		const data = [];
		for await (const chunk of process.stdin) data.push(chunk);
		const mode = path => statSync(path).mode & 0o777;
		const { HOME, PATH, TMPDIR, OMP_GUI_SCRATCH, OMP_GUI_SESSION_TAG, OMP_GUI_BRIDGE } = process.env;
		const leaked = ["WSLENV", "WSL_PROOF_SENTINEL", "PI_CODING_AGENT_DIR", "USERPROFILE", "HOST_DOTENV", "INVOCATION_ID"].some(k => k in process.env);
		console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: { HOME, PATH, TMPDIR, OMP_GUI_SCRATCH, OMP_GUI_SESSION_TAG, OMP_GUI_BRIDGE }, leaked,
			umask: process.umask(), body: Buffer.concat(data).toString('hex'), socketMode: mode(dirname(process.env.OMP_GUI_BRIDGE)) }));
		process.stderr.write('stock stderr\\n');
		process.exitCode = 17;
	`,
		{ mode: 0o600 },
	);
}

function send(f: Fixture, input: string) {
	const result = spawnSync("bun", ["--no-env-file", launch, f.request.spawnId], {
		...f.options,
		input,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return result;
}

function refused(f: Fixture, input: string, reason: RegExp) {
	const result = send(f, input);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(
		result.stderr
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line)),
	).toEqual([
		{ type: "ompdesk-wsl-attached", invocationId: f.options.env.INVOCATION_ID },
		{ type: "ompdesk-wsl-error", message: expect.stringMatching(reason) },
	]);
}

it("never attaches without a valid guest service invocation ID", () => {
	const f = fixture();
	f.env.INVOCATION_ID = "not-a-systemd-id";
	const result = send(f, "{}\n");
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(JSON.parse(result.stderr)).toMatchObject({
		type: "ompdesk-wsl-error",
		message: expect.stringMatching(/INVOCATION_ID/),
	});
});

it("rejects a valid launch addressed to a different service before accessing guest paths", () => {
	const f = fixture();
	refused(
		f,
		`${JSON.stringify({ ...f.request, spawnId: id(), cwd: "/work", sessionDir: "/assigned", bridgeDir: "/bridge" })}\n`,
		/assigned service/,
	);
});

it("refuses oversized or unterminated headers without sending stock bytes", () => {
	const f = fixture();
	refused(f, "x".repeat(16385), /16 KiB/);
	refused(f, "{}", /LF-terminated/);
});

it("rejects injected fields, noncanonical IDs, host paths and session traversal at the wire", () => {
	const f = fixture();
	const req = { ...f.request, bridgeDir: "/bridge", cwd: "/work", sessionDir: "/assigned" };
	for (const [patch, reason] of [
		[{ env: { PATH: "C:\\host" } }, /unexpected/i],
		[{ spawnId: "A".repeat(32) }, /ID/],
		[{ cwd: "C:\\host" }, /Linux paths/],
		[{ sessionDir: "/assigned/../other" }, /Linux paths/],
		[{ sessionBasename: "../other.jsonl" }, /basename/],
		[{ sessionBasename: "con .jsonl" }, /basename/],
		[{ sessionBasename: "abc:secret.jsonl" }, /basename/],
		[{ model: "--config" }, /selector/],
	] as const)
		refused(f, `${JSON.stringify({ ...req, ...patch })}\n`, reason);
});

describe.skipIf(!linux)("guest Linux launch", () => {
	it("fails before ready for absent or old guest stock and for an unsupported engine", () => {
		const f = fixture();
		const header = `${JSON.stringify(f.request)}\n`;
		refused(f, header, /ENOENT/);
		install(f, "19.1.99");
		refused(f, header, /19\.2\.0/);
		install(f, "19.2.0", ">=999.0.0");
		refused(f, header, /engines\.bun/);
	});

	it("refuses linked sessions, linked storage and linked scratch without writing through them", () => {
		const f = fixture();
		install(f);
		const file = join(f.home, "other.jsonl");
		writeFileSync(file, "");
		symlinkSync(file, join(f.request.sessionDir, basename));
		refused(f, `${JSON.stringify({ ...f.request, sessionBasename: basename })}\n`, /regular session/);
		const linked = join(f.home, "linked");
		symlinkSync(f.request.sessionDir, linked);
		refused(f, `${JSON.stringify({ ...f.request, sessionDir: linked })}\n`, /session directory/);
		symlinkSync(f.request.cwd, join(f.home, ".cache"));
		refused(f, `${JSON.stringify(f.request)}\n`, /Unsafe guest directory/);
		expect(existsSync(join(f.request.cwd, "ompdesk"))).toBe(false);
	});

	it("refuses a non-directory project and an existing scratch readable by another user", () => {
		const f = fixture();
		install(f);
		refused(
			f,
			`${JSON.stringify({ ...f.request, cwd: join(f.home, ".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/package.json") })}\n`,
			/project directory/,
		);
		const scratch = join(f.home, ".cache/ompdesk/scratch", f.request.tabTag);
		mkdirSync(scratch, { recursive: true, mode: 0o700 });
		chmodSync(scratch, 0o755);
		refused(f, `${JSON.stringify(f.request)}\n`, /Unsafe guest directory/);
	});

	it.skipIf(!existsSync(runtime))(
		"announces exec before accepting RPC, closes stdin on EOF, keeps stock output and status",
		async () => {
			const f = fixture();
			install(f);
			writeFileSync(join(f.request.cwd, ".env"), "HOST_DOTENV=leaked\n");
			writeFileSync(join(f.request.cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
			writeFileSync(join(f.request.cwd, "preload.ts"), 'throw Error("project preload ran")');
			const child = spawn("bun", ["--no-env-file", launch, f.request.spawnId], { ...f.options, stdio: "pipe" });
			const closed = once(child, "close");
			const stdout: Buffer[] = [];
			child.stdout.on("data", data => stdout.push(data));
			const stderr = createInterface({ input: child.stderr })[Symbol.asyncIterator]();
			try {
				expect(JSON.parse((await stderr.next()).value!)).toEqual({
					type: "ompdesk-wsl-attached",
					invocationId: f.env.INVOCATION_ID,
				});
				expect(stdout).toEqual([]);
				child.stdin.write(`${JSON.stringify(f.request)}\n`);
				expect(JSON.parse((await stderr.next()).value!)).toEqual({
					type: "ompdesk-wsl-ready",
					spawnId: f.request.spawnId,
				});
				child.stdin.end(Buffer.from([0, 10, 128, 255]));
				expect((await stderr.next()).value).toBe("stock stderr");
				expect(await closed).toEqual([17, null]);
			} finally {
				child.stdin.end();
				if (child.exitCode === null && child.signalCode === null) child.kill();
			}
			const reply = JSON.parse(Buffer.concat(stdout).toString());
			const scratch = join(f.home, ".cache/ompdesk/scratch", f.request.tabTag);
			const socket = join(runtime, "ompdesk", f.request.spawnId, "bridge.sock");
			expect(reply).toMatchObject({
				cwd: f.request.cwd,
				body: "000a80ff",
				umask: 0o077,
				socketMode: 0o700,
				args: [
					"--mode",
					"rpc-ui",
					"-e",
					join(bridgeDir, "index.ts"),
					"--session-dir",
					f.request.sessionDir,
					"--config",
					join(bridgeDir, "fresh-launch.yml"),
				],
				env: {
					HOME: f.home,
					TMPDIR: scratch,
					OMP_GUI_SCRATCH: scratch,
					OMP_GUI_SESSION_TAG: f.request.tabTag,
					OMP_GUI_BRIDGE: socket,
				},
			});
			expect(reply.leaked).toBe(false);
			expect(reply.env.PATH).toBe(`/usr/local/bin:/usr/bin:/bin:${f.home}/.bun/bin`);
			expect(lstatSync(scratch).mode & 0o777).toBe(0o700);
			expect(existsSync(dirname(socket))).toBe(false);
		},
	);

	it.skipIf(!existsSync(runtime))("resumes the assigned file, preserving input coalesced with the header", () => {
		const f = fixture();
		install(f);
		const file = join(f.request.sessionDir, basename);
		writeFileSync(file, "");
		const result = send(
			f,
			`${JSON.stringify({ ...f.request, sessionBasename: basename, model: "guest/model" })}\n{}\n`,
		);
		expect(result.status).toBe(17);
		expect(JSON.parse(result.stdout)).toMatchObject({
			args: [
				"--mode",
				"rpc-ui",
				"-e",
				join(bridgeDir, "index.ts"),
				"--session-dir",
				f.request.sessionDir,
				"--session",
				file,
				"--model",
				"guest/model",
			],
			body: "7b7d0a",
		});
	});
});
