// Windows-only protocol proof, not a session-host or installed-app test. bun scripts/wsl-supervisor-check.ts <registered WSL 2 GUID>
import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const distro = process.argv[2] ?? "";
assert(
	process.platform === "win32" && /^\{[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\}$/i.test(distro),
	"A registered WSL 2 distribution ID is required",
);
const root = process.env.SystemRoot;
assert(root);
const wsl = resolve(root, "System32", "wsl.exe");
const args = ["--distribution-id", distro, "--cd", "/", "--exec"];
const options = { env: { SystemRoot: root, WSLENV: "" }, windowsHide: true };
const guest = (...command: string[]) =>
	execFileSync(wsl, [...args, ...command], { ...options, timeout: 10_000, encoding: "utf8" }).trim();
const supervisor = guest(
	"/usr/bin/wslpath",
	"-a",
	"-u",
	resolve(import.meta.dir, "../resources/gui-bridge/wsl/supervisor.sh"),
);
const uid = guest("/usr/bin/id", "-u");
assert.match(uid, /^[1-9]\d*$/);
const control = (op: string, id: string, invocation: string, owner = uid) => [
	"/bin/sh",
	supervisor,
	op,
	id,
	invocation,
	owner,
];
const id = () => randomBytes(16).toString("hex");
const first = id();
const second = id();
const launched = new Map<string, ChildProcessWithoutNullStreams>();

async function startFixture(spawnId: string) {
	// setsid takes the grandchild out of the shell's process group, not out of the service cgroup.
	const child = spawn(
		wsl,
		[
			...args,
			"/usr/bin/systemd-run",
			"--user",
			"--quiet",
			"--wait",
			"--pipe",
			"--collect",
			"--expand-environment=no",
			`--unit=ompdesk-${spawnId}.service`,
			"-p",
			"KillMode=control-group",
			"-p",
			"ExitType=cgroup",
			"/bin/sh",
			"-c",
			'setsid sleep 60 </dev/null >/dev/null 2>&1 & printf "%s %s\\n" "$INVOCATION_ID" "$!"; exec sleep 60',
		],
		options,
	);
	launched.set(spawnId, child);
	const lines = createInterface({ input: child.stdout });
	try {
		const [line] = await once(lines, "line", { signal: AbortSignal.timeout(10_000) });
		const match = /^([a-f0-9]{32}) ([1-9]\d*)$/.exec(String(line));
		assert(match, "The test unit did not acknowledge admission");
		return { child, invocation: match[1], grandchild: match[2] };
	} finally {
		lines.close();
	}
}

try {
	const a = await startFixture(first);
	const b = await startFixture(second);
	assert.equal(guest(...control("state", first, a.invocation)), "owned");
	assert.equal(guest(...control("state", second, b.invocation)), "owned");
	const exited = once(a.child, "exit", { signal: AbortSignal.timeout(5_000) });
	a.child.kill();
	await exited;
	assert.equal(guest(...control("state", first, a.invocation)), "owned", "Win32 exit is not guest stop evidence");
	const wrong = spawnSync(wsl, [...args, ...control("stop", first, b.invocation)], { ...options, timeout: 5_000 });
	assert(
		wrong.status !== null && wrong.status !== 0 && wrong.stdout.length === 0,
		"A mismatched invocation must not stop the unit",
	);
	assert.equal(guest(...control("state", first, a.invocation)), "owned");
	assert.equal(guest(...control("stop", first, a.invocation)), "stopped");
	guest("/usr/bin/test", "!", "-d", `/proc/${a.grandchild}`);
	assert.equal(guest(...control("state", second, b.invocation)), "owned");
	guest("/usr/bin/test", "-d", `/proc/${b.grandchild}`);
	assert.equal(guest(...control("stop", first, a.invocation)), "stopped");
	for (const op of ["state", "stop"]) {
		const otherUser = spawnSync(wsl, [...args, ...control(op, first, a.invocation, uid === "1" ? "2" : "1")], {
			...options,
			timeout: 5_000,
		});
		assert(
			otherUser.status !== null && otherUser.status !== 0 && otherUser.stdout.length === 0,
			"Wrong user witnessed a stop",
		);
	}
	assert.equal(guest(...control("stop", second, b.invocation)), "stopped");
	console.log(
		"PASS: a Win32 launcher exit retained guest ownership; wrong invocation refused; targeted stop removed the detached child, preserved the second unit and remained stopped on repeat.",
	);
} finally {
	// Only test-created names. The 60 s fixture lifetime also bounds a lost WSL connection.
	for (const [spawnId, child] of launched) {
		spawnSync(wsl, [...args, "/usr/bin/systemctl", "--user", "stop", `ompdesk-${spawnId}.service`], {
			...options,
			timeout: 5_000,
			stdio: "ignore",
		});
		child.kill();
	}
}
