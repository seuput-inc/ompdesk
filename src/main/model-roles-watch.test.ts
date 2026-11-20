import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchModelRoles } from "./model-roles-watch";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A save as stock's: the whole file to a temp name, then a rename over config.yml. */
function save(file: string, text: string): void {
	writeFileSync(`${file}.tmp`, text);
	renameSync(`${file}.tmp`, file);
}

describe("watchModelRoles", () => {
	it("logs each role a save changed, whoever wrote it, with the omps running then", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-roles-watch-"));
		dirs.push(dir);
		const file = join(dir, "config.yml");
		save(
			file,
			"modelRoles:\n  slow: anthropic/claude-opus-5-5\n  advisor: anthropic/claude-opus-5-5:auto\n  task: a/b\ncompaction:\n  thresholdTokens: 1\n",
		);
		const logged = Promise.withResolvers<{ changes: string[]; pids: number[] }>();
		stops.push(
			watchModelRoles({
				configFile: file,
				pids: () => [101, 202],
				log: (changes, pids) => logged.resolve({ changes, pids }),
			}),
		);

		save(
			file,
			"modelRoles:\n  slow: anthropic/claude-fable-5-2\n  advisor: openai-codex/gpt-6.2-astra:auto\n  task: a/b\n  review: x/y:high\ncompaction: {}\n",
		);

		expect(await logged.promise).toEqual({
			changes: [
				"advisor: anthropic/claude-opus-5-5:auto → openai-codex/gpt-6.2-astra:auto",
				"review: (none) → x/y:high",
				"slow: anthropic/claude-opus-5-5 → anthropic/claude-fable-5-2",
			],
			pids: [101, 202],
		});
	});
});
