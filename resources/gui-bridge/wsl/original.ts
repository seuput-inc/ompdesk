import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from "node:fs";
import { join } from "node:path/posix";
import { SESSION_TAG_PATTERN } from "../runtime-identifiers";

const tmpfs = 0x01021994;
// ext2/3/4, XFS, Btrfs and F2FS. tmpfs is suitable for scratch and sockets, never a session original.
const persistent = new Set([0xef53, 0x58465342, 0x9123683e, 0xf2f52010]);
export function native(path: string, requirePersistent = false) {
	const fs = statfsSync(path).type >>> 0;
	if (!persistent.has(fs) && (requirePersistent || fs !== tmpfs)) {
		throw new Error(`Not a supported ${requirePersistent ? "persistent " : ""}native Linux filesystem: ${path}`);
	}
}

export function ownedDir(path: string, uid: number, privateMode: boolean) {
	const st = lstatSync(path);
	if (
		!st.isDirectory() ||
		st.uid !== uid ||
		realpathSync(path) !== path ||
		(privateMode ? (st.mode & 0o7777) !== 0o700 : !!(st.mode & 0o022))
	) {
		throw new Error(`Unsafe guest directory: ${path}`);
	}
	native(path);
}

export function ensureOwned(path: string, uid: number, privateMode = true) {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	ownedDir(path, uid, privateMode);
}

export function sessionName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 6 &&
		value.endsWith(".jsonl") &&
		!/\p{Cc}/u.test(value) &&
		!/[\\/:*?"<>|]/.test(value) &&
		!/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9¹²³]) *\./i.test(value)
	);
}

export function originalDirectory(home: string, key: string, uid: number, create = false): string {
	if (!SESSION_TAG_PATTERN.test(key) || home === "/" || !home.startsWith("/"))
		throw new Error("Invalid guest session key or home");
	ownedDir(home, uid, false);
	const root = join(home, ".ompdesk-sessions");
	if (create) ensureOwned(root, uid);
	else ownedDir(root, uid, true);
	native(root, true);
	const dir = join(root, key);
	if (create) mkdirSync(dir, { mode: 0o700 });
	ownedDir(dir, uid, true);
	native(dir, true);
	return dir;
}

export function openOriginal(home: string, key: string, basename: string, uid: number): number {
	if (!sessionName(basename)) throw new Error("Invalid WSL session basename");
	const dir = originalDirectory(home, key, uid);
	const path = join(dir, basename);
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	try {
		const file = fstatSync(fd, { bigint: true });
		if (
			!file.isFile() ||
			file.uid !== BigInt(uid) ||
			file.nlink !== 1n ||
			(file.mode & 0o7777n) !== 0o600n ||
			realpathSync(`/proc/self/fd/${fd}`) !== path
		)
			throw new Error("Expected a private regular session file");
		native(`/proc/self/fd/${fd}`, true);
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}
