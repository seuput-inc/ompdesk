/**
 * `stripDenylistedFlags` (`src/shared/launch-profile.ts`) copies which launch flags take the next token as their
 * value from stock `cli/flag-tables`, because it runs before omp starts and in the renderer's launch preview. For
 * every denylisted flag and every flag a launch profile emits, stock `flagConsumesValue` decides here what the
 * strip must do with the token that follows: drop it with a denylisted flag, keep it unread as a kept flag's value,
 * or read it as a flag of its own.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DENYLISTED_FLAGS, profileToFlags, stripDenylistedFlags } from "../shared/launch-profile";
import { runStock, stockSource } from "./test-bridge-probe";

const flagTables = stockSource("pi-coding-agent", path.join("cli", "flag-tables.ts"));

const PROFILE_FLAGS = profileToFlags({
	systemPrompt: "p",
	appendSystemPrompt: "p",
	noRules: true,
	addDirs: ["/a"],
	tools: ["read"],
	noLsp: true,
	planYolo: true,
	profile: "fast",
	sessionDir: "/s",
	config: "/c",
}).filter(token => token.startsWith("--"));

const FLAGS = [...new Set([...DENYLISTED_FLAGS, ...PROFILE_FLAGS])];
const NEXT = ["value", "", "-x", "--no-lsp", "--session", "--mode=text"];

describe.skipIf(!flagTables)("launch flag values against the installed stock flag tables", () => {
	it("treats the token after each flag as stock's argv parser reads it", () => {
		const consumes = runStock<boolean[][]>(
			`const { flagConsumesValue } = await import(${JSON.stringify(flagTables)});
			console.log(JSON.stringify(${JSON.stringify(FLAGS)}.map(flag => ${JSON.stringify(NEXT)}.map(next => flagConsumesValue(flag, next)))));`,
		);
		const denylisted = new Set(DENYLISTED_FLAGS);
		const cases = FLAGS.flatMap((flag, row) =>
			NEXT.map((next, column) => {
				const read = consumes[row]?.[column] === true;
				const rest = stripDenylistedFlags([next]);
				const expected = denylisted.has(flag) ? (read ? [] : rest) : read ? [flag, next] : [flag, ...rest];
				return { flag, next, expected, ours: stripDenylistedFlags([flag, next]) };
			}),
		);
		expect(cases.map(({ flag, next, ours }) => ({ flag, next, ours }))).toEqual(
			cases.map(({ flag, next, expected }) => ({ flag, next, ours: expected })),
		);
		expect(PROFILE_FLAGS).toContain("--system-prompt");
	}, 90_000);
});
