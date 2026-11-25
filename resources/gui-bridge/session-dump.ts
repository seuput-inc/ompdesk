import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { guard } from "./health";
import { redactDiagnosticsText } from "./redactor";
import { redactedDumpMembers } from "./session-dump-core";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = guard("sessionDump", {
	session_dump_redacted: async (params, env) => {
		if (typeof params !== "object" || !params || !("output" in params) || typeof params.output !== "string")
			throw new Error("Missing archive destination");
		const output = params.output;
		const id = /^ompdesk-archive-([a-f0-9]{32})$/.exec(path.basename(path.dirname(output)))?.[1];
		if (!id || !path.isAbsolute(output) || path.basename(output) !== `ompdesk-dump-${id}.zip`)
			throw new Error("Invalid archive destination");
		const anonymized = "anonymized" in params && params.anonymized === true;
		const session = env.session();
		let stock: Awaited<ReturnType<typeof session.dumpSessionArchiveToTmpDir>>;
		try {
			stock = anonymized
				? await session.dumpAnonymizedArchiveToTmpDir()
				: await session.dumpSessionArchiveToTmpDir();
		} catch {
			throw new Error("Could not create the session archive");
		}
		if (!stock) return null;
		try {
			// The running omp supplies this codec. An older install must not break bridge startup.
			const { openArchive, encodeArchive } = await import("./omp/pi-utils/ar");
			const source = await openArchive(stock.path, {
				// Stock generated this archive. A member larger than the browser's default 64 MiB is still text.
				limits: { maxMemberSize: Number.MAX_SAFE_INTEGER },
			});
			const { members, dropped } = await redactedDumpMembers(
				source.indexEntries(),
				async name => (await source.readFile(name)).bytes,
			);
			const zip = await encodeArchive("zip", members);
			const handle = await fs.open(output, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
			try {
				const meta = await handle.stat();
				const proof = Buffer.alloc(32);
				if (
					!meta.isFile() ||
					meta.size !== proof.length ||
					(await handle.read(proof, 0, proof.length, 0)).bytesRead !== proof.length ||
					proof.toString() !== id
				) {
					throw new Error("Invalid archive reservation");
				}
				await handle.writeFile(zip);
				if (zip.length < proof.length) await handle.truncate(zip.length);
			} finally {
				await handle.close();
			}
			return {
				path: output,
				files: [...members.keys()],
				dropped: dropped.length ? dropped : undefined,
				subagentCount: stock.subagentCount,
				subagentError: stock.subagentError ? redactDiagnosticsText(stock.subagentError) : undefined,
				anonymized,
				redacted: true,
			};
		} catch {
			// Stock archive errors can contain member names or session paths.
			throw new Error("Could not prepare the redacted session archive");
		} finally {
			await fs.rm(stock.path, { force: true }).catch(() => {
				throw new Error("Could not remove the original session archive");
			});
		}
	},
});
