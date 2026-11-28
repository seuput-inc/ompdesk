import { spawn } from "node:child_process";
import { once } from "node:events";
import {
	closeSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path/posix";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { NUMERIC_VERSION, SESSION_TAG_PATTERN } from "../runtime-identifiers";
import { ensureOwned, native, openOriginal, originalDirectory, ownedDir, sessionName } from "./original";

const MAX_HEADER = 16 * 1024;
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const control = /\p{Cc}/u;
const id = (s: unknown): s is string => typeof s === "string" && SESSION_TAG_PATTERN.test(s);

function requireThat(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

function guestPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!control.test(value) &&
		!value.includes("\\") &&
		(value === "/" ||
			value
				.slice(1)
				.split("/")
				.every(part => part && part !== "." && part !== ".."))
	);
}

function parseHeader(bytes: Buffer) {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new Error("Expected a UTF-8 JSON launch request");
	}
	requireThat(raw !== null && typeof raw === "object" && !Array.isArray(raw), "Expected a WSL launch request");
	const fields = [
		"spawnId",
		"tabTag",
		"cwd",
		"sessionKey",
		"sessionBasename",
		"bridgeDir",
		"minimumOmpVersion",
		"model",
	];
	requireThat(
		Object.keys(raw).every(k => fields.includes(k)),
		"Unexpected WSL launch field",
	);
	const { spawnId, tabTag, cwd, sessionKey, sessionBasename, bridgeDir, minimumOmpVersion, model } = raw as Record<
		string,
		unknown
	>;
	requireThat(id(spawnId) && id(tabTag) && id(sessionKey), "Invalid WSL spawn, tab or session ID");
	requireThat(guestPath(cwd) && guestPath(bridgeDir), "Expected absolute Linux paths");
	requireThat(sessionBasename === undefined || sessionName(sessionBasename), "Invalid WSL session basename");
	requireThat(
		typeof minimumOmpVersion === "string" &&
			!control.test(minimumOmpVersion) &&
			NUMERIC_VERSION.test(minimumOmpVersion),
		"Invalid minimum omp version",
	);
	requireThat(
		model === undefined ||
			(typeof model === "string" && /^[a-z\d][\w.@+:/-]{0,255}$/i.test(model) && !control.test(model)),
		"Invalid model selector",
	);
	return { spawnId, tabTag, cwd, sessionKey, sessionBasename, bridgeDir, minimumOmpVersion, model };
}

// Keep one stdin reader for both protocols. Bun can rewind a preclosed stdin when a second reader attaches.
async function readRequest() {
	const input = process.stdin[Symbol.asyncIterator]();
	const header = Buffer.allocUnsafe(MAX_HEADER);
	let pos = 0;
	for (;;) {
		const { value, done } = await input.next();
		requireThat(!done, "Missing LF-terminated WSL launch request");
		const chunk: Buffer = value;
		const lf = chunk.indexOf(10);
		const length = lf < 0 ? chunk.length : lf;
		requireThat(pos + length <= MAX_HEADER, "WSL launch request exceeds 16 KiB");
		chunk.copy(header, pos, 0, length);
		pos += length;
		if (lf >= 0) return { request: parseHeader(header.subarray(0, pos)), remainder: chunk.subarray(lf + 1), input };
	}
}

function guestFile(home: string, path: string, uid: number) {
	const file = realpathSync(path);
	const stat = lstatSync(file);
	requireThat(
		file.startsWith(`${home}/`) && stat.isFile() && stat.uid === uid && !(stat.mode & 0o022),
		`Expected guest-owned package file: ${path}`,
	);
	native(file);
	return file;
}

let ready = false;
async function launch() {
	const spawnId = process.argv[2];
	requireThat(process.argv.length === 3 && id(spawnId), "Expected the service's WSL spawn ID");
	const invocationId = process.env.INVOCATION_ID;
	requireThat(id(invocationId), "Missing or invalid guest systemd INVOCATION_ID");
	writeSync(2, `${JSON.stringify({ type: "ompdesk-wsl-attached", invocationId })}\n`);
	const { request: r, remainder, input } = await readRequest();
	requireThat(r.spawnId === spawnId, "WSL spawn ID does not match the assigned service");
	requireThat(
		process.platform === "linux" && process.getuid && process.versions.bun,
		"WSL launch requires guest Linux Bun",
	);
	process.umask(0o077);
	const uid = process.getuid();
	const home = process.env.HOME;
	requireThat(guestPath(home) && home !== "/", "Missing guest HOME");
	ownedDir(home, uid, false);
	const pkg = join(home, ".bun/install/global/node_modules", PACKAGE);
	const manifest = JSON.parse(readFileSync(guestFile(home, join(pkg, "package.json"), uid), "utf8"));
	requireThat(
		manifest.name === PACKAGE &&
			typeof manifest.version === "string" &&
			NUMERIC_VERSION.test(manifest.version) &&
			Bun.semver.satisfies(manifest.version, `>=${r.minimumOmpVersion}`),
		`Guest ${PACKAGE} ${r.minimumOmpVersion} or newer is required`,
	);
	const engine = manifest.engines?.bun;
	requireThat(
		typeof engine === "string" &&
			/^\s*>=\s*v?\d+\.\d+\.\d+\s*$/.test(engine) &&
			Bun.semver.satisfies(process.versions.bun, engine),
		"Guest Bun does not meet the omp package's declared engines.bun",
	);
	const cli = guestFile(home, join(pkg, "dist/cli.js"), uid);
	const bridge = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
	requireThat(realpathSync(r.bridgeDir) === bridge, "Expected the packaged OMPdesk bridge");
	const entry = join(bridge, "index.ts");
	requireThat(lstatSync(entry).isFile(), "Missing packaged OMPdesk bridge entry");
	requireThat(lstatSync(realpathSync(r.cwd)).isDirectory(), "Expected an existing project directory");
	const sessionDir = originalDirectory(home, r.sessionKey, uid, !r.sessionBasename);
	const args = [cli, "--mode", "rpc-ui", "-e", entry, "--session-dir", sessionDir];
	if (r.sessionBasename) {
		closeSync(openOriginal(home, r.sessionKey, r.sessionBasename, uid));
		args.push("--session", join(sessionDir, r.sessionBasename));
	} else {
		const config = join(bridge, "fresh-launch.yml");
		requireThat(lstatSync(config).isFile(), "Missing packaged fresh-launch config");
		args.push("--config", config);
	}
	if (r.model) args.push("--model", r.model);

	const cache = join(home, ".cache");
	ensureOwned(cache, uid, false);
	const appCache = join(cache, "ompdesk");
	ensureOwned(appCache, uid);
	const scratchRoot = join(appCache, "scratch");
	ensureOwned(scratchRoot, uid);
	const scratch = join(scratchRoot, r.tabTag);
	ensureOwned(scratch, uid);
	const runtime = `/run/user/${uid}`;
	ownedDir(runtime, uid, true);
	const sockets = join(runtime, "ompdesk");
	ensureOwned(sockets, uid);
	const dir = join(sockets, r.spawnId);
	mkdirSync(dir, { mode: 0o700 }); // Never reuse another spawn's socket, even after a crash.
	const socket = join(dir, "bridge.sock");
	const bunfig = join(dir, "bunfig.toml");
	try {
		ownedDir(dir, uid, true);
		writeFileSync(bunfig, "", { flag: "wx", mode: 0o600 });
		const child = spawn(process.execPath, ["--no-env-file", `--config=${bunfig}`, "--no-install", ...args], {
			cwd: r.cwd,
			windowsHide: true,
			env: {
				HOME: home,
				PATH: `/usr/local/bin:/usr/bin:/bin:${home}/.bun/bin`,
				TMPDIR: scratch,
				OMP_GUI_SCRATCH: scratch,
				OMP_GUI_SESSION_TAG: r.tabTag,
				OMP_GUI_BRIDGE: socket,
				OTEL_SDK_DISABLED: "true",
			},
			stdio: "pipe",
		});
		const close = Promise.withResolvers<number>();
		child.once("close", (code, signal) => close.resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
		await once(child, "spawn");
		const terminate = () => {
			child.kill("SIGTERM");
		};
		process.on("SIGTERM", terminate);
		process.on("SIGINT", terminate);
		const rest = Readable.from(input, { objectMode: false });
		rest.on("error", terminate);
		try {
			writeSync(2, `${JSON.stringify({ type: "ompdesk-wsl-ready", spawnId: r.spawnId })}\n`);
			ready = true;
			child.stdout.pipe(process.stdout, { end: false });
			child.stderr.pipe(process.stderr, { end: false });
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") terminate();
			});
			if (remainder.length) child.stdin.write(remainder);
			rest.pipe(child.stdin);
			return await close.promise;
		} finally {
			process.removeListener("SIGTERM", terminate);
			process.removeListener("SIGINT", terminate);
			rest.destroy();
			if (child.exitCode === null && child.signalCode === null) terminate();
		}
	} finally {
		rmSync(socket, { force: true });
		rmSync(bunfig, { force: true });
		rmdirSync(dir);
	}
}

try {
	process.exitCode = await launch();
} catch (error) {
	const message = error instanceof Error ? error.message : "Guest launch failed";
	writeSync(2, ready ? `WSL supervisor: ${message}\n` : `${JSON.stringify({ type: "ompdesk-wsl-error", message })}\n`);
	process.exitCode = 1;
} finally {
	process.stdin.destroy();
}
