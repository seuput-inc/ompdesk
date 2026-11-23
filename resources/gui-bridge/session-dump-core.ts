import { posix } from "node:path";
import { redactDiagnosticsFile, redactDiagnosticsText } from "./redactor";

/** Reads members one at a time. Only the retained names and redacted text go to the new ZIP. */
export async function redactedDumpMembers(
	entries: Iterable<{ path: string; isDirectory: boolean }>,
	read: (name: string) => Promise<Uint8Array>,
): Promise<{ members: Map<string, string>; dropped: string[] }> {
	const members = new Map<string, string>();
	const dropped: string[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let nextDuplicate = 2;
	for (const entry of entries) {
		if (entry.isDirectory) continue;
		const name = redactDiagnosticsText(entry.path);
		let text: string | undefined;
		try {
			text = decoder.decode(await read(entry.path));
		} catch {}
		if (text === undefined || text.includes("\0")) {
			dropped.push(name);
			continue;
		}
		let kept = name;
		if (members.has(kept)) {
			const ext = posix.extname(name);
			const stem = name.slice(0, name.length - ext.length);
			while (members.has(kept)) kept = `${stem} (${nextDuplicate++})${ext}`;
		}
		members.set(kept, redactDiagnosticsFile(entry.path, text));
	}
	return { members, dropped };
}
