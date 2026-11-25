/**
 * Which of OMPdesk's dictionaries an omp outgrew, as one list.
 *
 *   bun scripts/omp-bump/extract.ts [<omp package root>]          diff JSON: per dictionary, `missing` and `stale`
 *   bun scripts/omp-bump/extract.ts [<omp package root>] --check  exit 1 listing every missing required string
 *
 * The root is the `@oh-my-pi/pi-coding-agent` package folder: the argument, else `OMP_PACKAGE_ROOT`, else the global
 * Bun install. `--check` fails on exactly what the completeness tests assert (dictionaries.ts) and prints nothing else.
 */
import path from "node:path";
import { diffDictionaries, INSTALLED_OMP_ROOT, missingStrings } from "./dictionaries";
import { collectStockFacts } from "./stock-facts";

const args = process.argv.slice(2);
const check = args.includes("--check");
const unknown = args.filter(arg => arg.startsWith("-") && arg !== "--check");
const roots = args.filter(arg => !arg.startsWith("-"));
if (unknown.length > 0 || roots.length > 1) {
	console.error("usage: bun scripts/omp-bump/extract.ts [<omp package root>] [--check]");
	process.exit(2);
}
const root = path.resolve(roots[0] ?? process.env.OMP_PACKAGE_ROOT ?? INSTALLED_OMP_ROOT);
process.env.OMP_PACKAGE_ROOT = root;
const facts = await collectStockFacts();
const diffs = diffDictionaries(facts);

if (!check) {
	console.log(JSON.stringify({ omp: facts.version, root, dictionaries: diffs }, null, "\t"));
} else {
	const missing = missingStrings(diffs);
	if (missing.length > 0) {
		console.error(`omp ${facts.version} has ${missing.length} strings OMPdesk's dictionaries lack:`);
		for (const line of missing) console.error(`  ${line}`);
		process.exit(1);
	}
	console.log(`omp ${facts.version}: every required dictionary covers it`);
}
