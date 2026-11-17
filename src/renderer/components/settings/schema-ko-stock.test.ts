import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type DictionaryDiff,
	diffDictionaries,
	INSTALLED_OMP_ROOT,
	missingStrings,
	readStockFacts,
} from "../../../../scripts/omp-bump/dictionaries";
import type { StockFacts } from "../../../../scripts/omp-bump/stock-facts";
import { modelRoleName } from "./schema-i18n";

// The installed stock's words, read the way `bun scripts/omp-bump/extract.ts --check` reads any omp
// (scripts/omp-bump/dictionaries.ts), so this test and that check fail on the same strings.
describe.skipIf(!existsSync(join(INSTALLED_OMP_ROOT, "package.json")))(
	"Korean coverage of installed stock settings",
	() => {
		// A hook, not the describe body: vitest runs a skipped suite's body to collect it, never its hooks.
		let facts: StockFacts;
		let diffs: DictionaryDiff[];
		beforeAll(() => {
			facts = readStockFacts(INSTALLED_OMP_ROOT);
			diffs = diffDictionaries(facts);
		}, 60_000);

		it("has an explicit Korean entry for every UI setting, group and option text", () => {
			expect(facts.settings.length).toBeGreaterThan(0);
			expect(
				missingStrings(diffs, ["settings.label", "settings.description", "settings.group", "settings.option"]),
			).toEqual([]);
		});

		it("has a Korean name for every built-in model role stock names", () => {
			expect(facts.roleNames.length).toBeGreaterThan(0);
			expect(missingStrings(diffs, ["roles.name"])).toEqual([]);
			expect(
				facts.roleNames.every(
					name =>
						modelRoleName("en", name) ===
						(name === "Architect" ? "Plan" : name === "Commit" ? "Commit messages" : name),
				),
			).toBe(true);
		});
	},
);

describe("Korean role names", () => {
	it("gives a role the same name whichever stock name it comes under, so Settings and the setup dialog agree", () => {
		expect(modelRoleName("ko", "Architect")).toBe(modelRoleName("ko", "Plan"));
		expect(modelRoleName("ko", "Commit")).toBe(modelRoleName("ko", "Commit messages"));
		expect(modelRoleName("en", "Architect")).toBe(modelRoleName("en", "Plan"));
		expect(modelRoleName("en", "Commit")).toBe(modelRoleName("en", "Commit messages"));
	});
});
