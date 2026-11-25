/**
 * Contract tests for launch profiles (plan B3): the flag mapping, the
 * code-controlled-flag denylist (which guarantees a profile can never
 * override sidecar-owned argv like --session/--mode), and the
 * effective-command-line preview shown in Settings. Parsing stored profiles
 * is the core's (`crates/core/src/prefs/launch_profile.rs`).
 */
import { describe, expect, it } from "vitest";
import {
	DENYLISTED_FLAGS,
	flagsToCommandLine,
	profileToFlags,
	stripDenylistedFlags,
} from "../../shared/launch-profile";

describe("profileToFlags mapping", () => {
	it("maps every field to its CLI flag in a fixed order", () => {
		const flags = profileToFlags({
			systemPrompt: "You are terse.",
			appendSystemPrompt: "Always run tests.",
			noRules: true,
			addDirs: ["/tmp/a", "/tmp/b"],
			tools: ["read", "bash"],
			noLsp: true,
			planYolo: true,
			profile: "fast",
			sessionDir: "/tmp/sessions",
			config: "/tmp/config.yml",
		});
		expect(flags).toEqual([
			"--system-prompt",
			"You are terse.",
			"--append-system-prompt",
			"Always run tests.",
			"--no-rules",
			"--add-dir",
			"/tmp/a",
			"--add-dir",
			"/tmp/b",
			"--tools",
			"read,bash",
			"--no-lsp",
			"--plan-yolo",
			"--profile",
			"fast",
			"--session-dir",
			"/tmp/sessions",
			"--config",
			"/tmp/config.yml",
		]);
	});

	it("emits nothing for an empty profile", () => {
		expect(profileToFlags({})).toEqual([]);
	});

	it("skips blank strings, false booleans, and empty arrays", () => {
		expect(
			profileToFlags({
				systemPrompt: "   ",
				appendSystemPrompt: "",
				noRules: false,
				addDirs: [],
				tools: [],
				noLsp: false,
				planYolo: false,
				profile: "  ",
				sessionDir: "",
				config: " ",
			}),
		).toEqual([]);
	});

	it("preserves prompt whitespace verbatim (trimming would rewrite the prompt)", () => {
		expect(profileToFlags({ appendSystemPrompt: "line one\nline two\n" })).toEqual([
			"--append-system-prompt",
			"line one\nline two\n",
		]);
	});

	it("trims tool names and joins them csv; all-blank lists emit no flag", () => {
		expect(profileToFlags({ tools: [" read ", "", "bash"] })).toEqual(["--tools", "read,bash"]);
		expect(profileToFlags({ tools: [" ", ""] })).toEqual([]);
	});

	it("drops blank add-dir entries and trims the rest", () => {
		expect(profileToFlags({ addDirs: [" /data ", ""] })).toEqual(["--add-dir", "/data"]);
	});
});

describe("denylist", () => {
	it("drops every code-controlled flag, value token included", () => {
		for (const flag of DENYLISTED_FLAGS) {
			expect(stripDenylistedFlags([flag, "value", "--tools", "read"])).toEqual(
				flag === "--session" ||
					flag === "--mode" ||
					flag === "--export" ||
					flag === "--cwd" ||
					flag === "--resume" ||
					flag === "--fork" ||
					flag === "--api-key"
					? ["--tools", "read"]
					: ["value", "--tools", "read"],
			);
		}
	});

	it("drops the --flag=value form in one token", () => {
		expect(stripDenylistedFlags(["--mode=text", "--session=/tmp/x.jsonl", "--no-lsp"])).toEqual(["--no-lsp"]);
	});

	it("does not swallow the next flag-looking token as a value", () => {
		expect(stripDenylistedFlags(["--session", "--tools", "read"])).toEqual(["--tools", "read"]);
	});

	it("keeps non-denylisted flags untouched and in order", () => {
		expect(stripDenylistedFlags(["--no-rules", "--add-dir", "/a", "--tools", "read,bash"])).toEqual([
			"--no-rules",
			"--add-dir",
			"/a",
			"--tools",
			"read,bash",
		]);
	});

	it("preserves a profile value that merely looks like a denylisted flag", () => {
		// A value equal to a protected flag is DATA, not an override — it must
		// survive pair-aware stripping so the agent receives it as the value.
		expect(profileToFlags({ appendSystemPrompt: "--session" })).toEqual(["--append-system-prompt", "--session"]);
		expect(stripDenylistedFlags(["--append-system-prompt", "--session", "--tools", "read"])).toEqual([
			"--append-system-prompt",
			"--session",
			"--tools",
			"read",
		]);
		expect(stripDenylistedFlags(["--config", "--mode=text"])).toEqual(["--config", "--mode=text"]);
	});
});

describe("flagsToCommandLine preview", () => {
	it("renders safe tokens bare and quotes tokens with whitespace", () => {
		expect(flagsToCommandLine(["--tools", "read,bash", "--append-system-prompt", "be nice"])).toBe(
			"--tools read,bash --append-system-prompt 'be nice'",
		);
	});

	it("escapes embedded single quotes POSIX-style", () => {
		expect(flagsToCommandLine(["it's"])).toBe("'it'\\''s'");
	});

	it("quotes newlines and empty strings", () => {
		expect(flagsToCommandLine(["a\nb", ""])).toBe("'a\nb' ''");
	});

	it("renders the empty flag list as an empty string", () => {
		expect(flagsToCommandLine([])).toBe("");
	});
});
