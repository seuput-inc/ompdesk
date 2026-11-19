// A .mjs on purpose: it imports a bridge area module, whose `@oh-my-pi/*` type imports the repo's tsc cannot resolve
// (tsconfig includes only .ts/.tsx).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// An omp whose slash-command completions module lost `buildMcpArgumentCompletions`; the local:// store is intact.
vi.mock("@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions", () => ({}));
vi.mock("@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry", () => ({ BUILTIN_SLASH_COMMANDS: [] }));
vi.mock("@oh-my-pi/pi-coding-agent/mcp/manager", () => ({ MCPManager: { instance: () => ({}) } }));
vi.mock("@oh-my-pi/pi-coding-agent/internal-urls/local-protocol", () => ({
	resolveLocalRoot: options => join(options.getArtifactsDir(), "local"),
	resolveLocalUrlToPath: () => "",
}));
vi.mock("@oh-my-pi/pi-utils", () => ({
	isEexist: error => error?.code === "EEXIST",
	getProjectDir: () => process.cwd(),
}));

const { methods } = await import("../../resources/gui-bridge/session-extras");

const artifacts = mkdtempSync(join(tmpdir(), "ompdesk-session-extras-"));
afterAll(() => rmSync(artifacts, { recursive: true, force: true }));

const env = {
	pi: { pi: { VERSION: "19.0.0" } },
	session: () => ({ sessionManager: { getArtifactsDir: () => artifacts, getSessionId: () => "s1" } }),
	context: () => {
		throw new Error("no context");
	},
	emit: () => {},
};

describe("session extras on an omp missing one stock export", () => {
	it("keeps large pastes working and refuses only argument completion, naming the missing export", async () => {
		const pasted = await methods["sessions.write_local_paste"]({ content: "big paste" }, env);
		expect(pasted).toEqual({ name: "paste-1.md", url: "local://paste-1.md" });
		expect(readFileSync(join(artifacts, "local", "paste-1.md"), "utf8")).toBe("big paste");

		const refused = await methods["sessions.arg_completions"]({ cwd: "/", command: "mcp", prefix: "" }, env).catch(
			error => error,
		);
		expect(refused).toMatchObject({ code: "unsupported_omp" });
		expect(refused.message).toMatch(
			/Slash-command argument completion \(missing @oh-my-pi\/pi-coding-agent\/slash-commands\/builtin-completions#buildMcpArgumentCompletions\)/,
		);
	});
});
