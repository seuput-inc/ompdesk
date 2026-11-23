import { z } from "zod";
import type { SessionArchive, SessionArchiveDiscard } from "../../shared/diagnostic-bundle";
import { core } from "../core/process";
import { LocalCommandError, type LocalHandler } from "./types";

interface Grant {
	path: string;
	receipt: string;
}

// Only published paths reach discard. The core independently verifies the private receipt, even after a restart.
const produced = new Map<string, Grant>();
const archiveReply = z.object({
	path: z.string(),
	files: z.array(z.string()),
	subagentCount: z.number().int().nonnegative(),
	anonymized: z.boolean(),
	redacted: z.literal(true),
	dropped: z.array(z.string()).optional(),
	subagentError: z.string().optional(),
});

async function discard(grant: Grant): Promise<SessionArchiveDiscard> {
	return (await core().call<SessionArchiveDiscard>("archive.discard", grant)).result;
}

export const handlers: Record<string, LocalHandler> = {
	dump_session_archive: async (command, ctx): Promise<SessionArchive> => {
		const anonymized = z.boolean().optional().parse(command.anonymized) === true;
		const { result: grant } = await core().call<Grant>("archive.prepare", {});
		try {
			const raw = await ctx.bridge.request("session_dump_redacted", { output: grant.path, anonymized });
			if (raw === null) throw new LocalCommandError("No messages to dump yet.", "no_messages");
			const answer = archiveReply.safeParse(raw);
			if (!answer.success || answer.data.path !== grant.path || answer.data.anonymized !== anonymized)
				throw new LocalCommandError("Unexpected redacted archive response", "remote_protocol");
			produced.set(grant.path, grant);
			return answer.data;
		} catch (error) {
			await discard(grant);
			throw error;
		}
	},

	discard_session_archive: async (command): Promise<SessionArchiveDiscard> => {
		const path = z.string().min(1).parse(command.path);
		const grant = produced.get(path);
		if (!grant) return { removed: false };
		produced.delete(path);
		try {
			return await discard(grant);
		} catch (error) {
			produced.set(path, grant);
			throw error;
		}
	},
};
