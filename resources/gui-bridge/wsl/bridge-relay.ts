import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { SESSION_TAG_PATTERN } from "../runtime-identifiers";

const id = process.argv[2];
if (process.platform !== "linux" || !process.getuid || process.argv.length !== 3 || !SESSION_TAG_PATTERN.test(id)) {
	throw new Error("Expected a Linux bridge spawn ID");
}

const uid = process.getuid();
const runtime = `/run/user/${uid}`;
const app = `${runtime}/ompdesk`;
const spawn = `${app}/${id}`;
for (const dir of ["/run", "/run/user", runtime, app, spawn]) {
	const stat = lstatSync(dir);
	const system = dir === "/run" || dir === "/run/user";
	if (
		!stat.isDirectory() ||
		stat.uid !== (system ? 0 : uid) ||
		(system ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o777) !== 0o700)
	) {
		throw new Error("Unsafe Linux bridge directory");
	}
}
const path = `${spawn}/bridge.sock`;
const stat = lstatSync(path);
if (!stat.isSocket() || stat.uid !== uid) throw new Error("Unsafe Linux bridge socket");

const socket = createConnection({ path });
const fail = () => process.exit(1);
socket.on("error", fail);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
socket.once("connect", () => {
	process.stdout.write("OK\n");
	socket.pipe(process.stdout);
	process.stdin.pipe(socket);
});
// EOF on either side ends this connection; don't wait for a half-open peer.
process.stdin.once("close", () => socket.end());
socket.once("finish", () => socket.destroy());
socket.once("close", () => {
	process.stdin.destroy();
	process.stdout.write("", () => process.exit(0));
});
