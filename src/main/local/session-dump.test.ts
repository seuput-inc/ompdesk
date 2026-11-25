import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redactedDumpMembers } from "../../../resources/gui-bridge/session-dump-core";
import type { SessionArchive } from "../../shared/diagnostic-bundle";
import { stopCore } from "../core/process";
import { localHandlerFor } from "./index";
import { handlers } from "./session-dump";
import { type LocalCommandContext, LocalCommandError } from "./types";

const roots: string[] = [];

async function tmp(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dump-handler-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it("keeps both members when their private names redact to the same name", async () => {
	const entries = ["first@example.test/turn.md", "second@example.test/turn.md"].map(path => ({
		path,
		isDirectory: false,
	}));
	const { members } = await redactedDumpMembers(entries, async path => Buffer.from(`Source: ${path}`));
	expect([...members]).toEqual([
		["<email>/turn.md", "Source: <email>/turn.md"],
		["<email>/turn (2).md", "Source: <email>/turn.md"],
	]);
});

interface Destination {
	output: string;
	anonymized: boolean;
}

const written = ({ output, anonymized }: Destination): SessionArchive => ({
	path: output,
	files: ["session.md"],
	subagentCount: 0,
	anonymized,
	redacted: true,
});

function fakeCtx(answer: (dest: Destination) => Promise<unknown> = async () => null) {
	const request = vi.fn(async (_method: string, params: Destination) => answer(params));
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.12.2", run: vi.fn() },
		send: vi.fn(async () => {
			throw new Error("stock RPC must not be asked: its /dump only prints the path");
		}),
		bridge: {
			request: request as LocalCommandContext["bridge"]["request"],
			connected: true,
		},
	};
	return { ctx, request };
}

const run = (type: string, fields: Record<string, unknown>, ctx: LocalCommandContext) => {
	const handler = handlers[type];
	if (!handler) throw new Error(`no handler ${type}`);
	return handler({ type, ...fields }, ctx);
};

describe("dump_session_archive", () => {
	it("is served locally, never forwarded to stock", () => {
		expect(localHandlerFor("dump_session_archive")).toBe(handlers.dump_session_archive);
		expect(localHandlerFor("discard_session_archive")).toBe(handlers.discard_session_archive);
	});

	it("gives the bridge a private output and the requested stock variant, never the deletion receipt", async () => {
		const { ctx, request } = fakeCtx(async dest => {
			if (process.platform !== "win32") {
				expect((await fs.stat(dest.output)).mode & 0o777).toBe(0o600);
				expect((await fs.stat(path.dirname(dest.output))).mode & 0o777).toBe(0o700);
			}
			return written(dest);
		});
		for (const anonymized of [false, true]) {
			const result = (await run("dump_session_archive", anonymized ? { anonymized } : {}, ctx)) as SessionArchive;
			expect(request).toHaveBeenLastCalledWith("session_dump_redacted", { output: result.path, anonymized });
			expect(result).toEqual(written({ output: result.path, anonymized }));
			await run("discard_session_archive", { path: result.path }, ctx);
		}
		expect(ctx.send).not.toHaveBeenCalled();
	});

	it.each(["raw", "foreign", "wrong variant"])("refuses a %s reply without authorizing its path", async kind => {
		const foreign = path.join(await tmp(), "precious.zip");
		await fs.writeFile(foreign, "keep");
		let reserved = "";
		const { ctx } = fakeCtx(async dest => {
			reserved = dest.output;
			return {
				...written(dest),
				path: kind === "foreign" ? foreign : reserved,
				redacted: kind !== "raw",
				anonymized: kind === "wrong variant",
			};
		});
		await expect(run("dump_session_archive", {}, ctx)).rejects.toMatchObject({ code: "remote_protocol" });
		await expect(fs.access(path.dirname(reserved))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(run("discard_session_archive", { path: foreign }, ctx)).resolves.toEqual({ removed: false });
		expect(await fs.readFile(foreign, "utf8")).toBe("keep");
	});

	it("discards the partial output and receipt when the bridge fails", async () => {
		let reserved = "";
		const { ctx } = fakeCtx(async ({ output }) => {
			reserved = output;
			await fs.writeFile(output, "incomplete");
			throw new Error("fixture write failed");
		});
		await expect(run("dump_session_archive", {}, ctx)).rejects.toThrow("fixture write failed");
		await expect(fs.access(path.dirname(reserved))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fails with the no_messages code while the session has nothing to dump", async () => {
		const { ctx } = fakeCtx();
		const failure = await run("dump_session_archive", {}, ctx).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(LocalCommandError);
		expect(failure).toMatchObject({ code: "no_messages" });
	});
});

describe("discard_session_archive", () => {
	it("discards a published archive exactly once after the core restarts", async () => {
		const { ctx } = fakeCtx(async dest => written(dest));
		const { path: file } = (await run("dump_session_archive", {}, ctx)) as { path: string };

		await stopCore();
		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: true });
		await expect(fs.access(path.dirname(file))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: false });
	});

	it("never deletes a file it did not produce, whoever asks (a paired device reaches it over the tab RPC path)", async () => {
		const file = path.join(await tmp(), "precious.txt");
		await fs.writeFile(file, "keep me");
		const { ctx } = fakeCtx();
		await expect(run("discard_session_archive", { path: file }, ctx)).resolves.toEqual({ removed: false });
		await expect(fs.readFile(file, "utf8")).resolves.toBe("keep me");
	});
});
