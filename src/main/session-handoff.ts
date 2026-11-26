/**
 * The sending side's ports of `handOffSession` (session-mutations.ts) on this computer: the link, the session index,
 * the project's origin and what of a stored session crosses, the way stock keeps a session: the journal, every file of
 * its artifacts folder (the journal's path without `.jsonl`, as stock's `deleteSessionWithArtifacts` and
 * `SessionManager.moveTo` treat it) and each picture blob the journal names (`blob:sha256:<hash>`, stock's
 * content-addressed store, which is not per session). A blob this computer no longer has is left out: the receiver
 * shows the picture as missing, as this computer would.
 */
import type { Dirent } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { coreGit } from "./local/git/exec";
import type { RemoteDevices } from "./remote/devices";
import { writeRuntimeLog } from "./runtime-log";
import type { SessionIndex } from "./session-index";
import type { HandOffDeps, HandOffPart } from "./session-mutations";
import { stockHelperRequest } from "./stock-helper";

const BLOB_REF = /blob:sha256:([0-9a-f]{64})/g;

function filePart(rel: string, file: string, size: number): HandOffPart {
	return {
		rel,
		size,
		read: async (offset, length) => {
			const handle = await open(file, "r");
			try {
				const bytes = Buffer.alloc(length);
				const { bytesRead } = await handle.read(bytes, 0, length, offset);
				return bytes.subarray(0, bytesRead);
			} finally {
				await handle.close();
			}
		},
	};
}

/** Every plain file under `dir` as a `/`-joined relative path; links are not followed, a missing folder has none. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) files.push(...(await filesUnder(path.join(dir, entry.name), rel)));
		else if (entry.isFile()) files.push(rel);
	}
	return files;
}

export async function handOffParts(sessionPath: string, blobsDir: string): Promise<HandOffPart[]> {
	const parts = [filePart("session.jsonl", sessionPath, (await stat(sessionPath)).size)];
	const artifacts = sessionPath.slice(0, -".jsonl".length);
	for (const rel of await filesUnder(artifacts)) {
		const file = path.join(artifacts, ...rel.split("/"));
		parts.push(filePart(`artifacts/${rel}`, file, (await stat(file)).size));
	}
	const journal = await readFile(sessionPath, "utf8");
	for (const hash of new Set(Array.from(journal.matchAll(BLOB_REF), match => match[1] ?? ""))) {
		const file = path.join(blobsDir, hash);
		const size = await stat(file).then(
			info => (info.isFile() ? info.size : null),
			() => null,
		);
		if (size !== null) parts.push(filePart(`blobs/${hash}`, file, size));
	}
	return parts;
}

/** `handOffSession`'s ports on this computer, its log lines in the runtime log (source `session-handoff`). */
export function handOffDeps(io: {
	devices: Pick<RemoteDevices, "request">;
	sessionIndex: Pick<SessionIndex, "recordedCwd" | "deleteSession" | "relist">;
}): HandOffDeps {
	return {
		request: (host, method, params, timeoutMs) => io.devices.request(host, method, params, timeoutMs),
		recordedCwd: sessionPath => io.sessionIndex.recordedCwd(sessionPath),
		// No git or no `origin`: only the same folder on the other computer is the project.
		origin: cwd =>
			coreGit<{ origin: string | null }>("remote.handoff.origin", { cwd }, 1).then(
				answer => answer.origin,
				() => null,
			),
		parts: async sessionPath =>
			handOffParts(
				sessionPath,
				(await stockHelperRequest<{ blobsDir: string }>("sessions.handoff_paths", {})).blobsDir,
			),
		removeStored: sessionPath => io.sessionIndex.deleteSession(sessionPath),
		relist: () => io.sessionIndex.relist(),
		log: (outcome, details) => writeRuntimeLog({ source: "session-handoff", message: outcome, details }),
	};
}
