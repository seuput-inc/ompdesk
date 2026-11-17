/**
 * Where OMPdesk's production code reaches a stock omp module. A reference is a runtime `import`/`export … from`,
 * a dynamic `import("…")`, `require("…")`, or a string literal that is exactly a module specifier (the `LOADERS`
 * form in health.ts), or a template that only joins such a file-local constant with a literal (`${AGENT}/discovery`).
 * An import of an adapter under `resources/gui-bridge/omp/` counts as a reference to the stock module it re-exports,
 * and an `omp-package.ts` key (`loadOmpModule("pi-ai")`) as one to `@oh-my-pi/<key>`; the layer's own files are
 * skipped, so a touchpoint lists the code that uses a module, not the adapter. `import type`, all-`type` named
 * imports and `import("…")` inside a type position are erased at runtime, so they are not references. Comments are
 * not nodes, so they never count. The walker is `scripts/lint-omp-imports.mjs`, which the import lint shares.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { OMP_ADAPTER_DIR, OMP_PACKAGE_FILE, ompSpecifiers, productionFiles } from "../lint-omp-imports.mjs";

export interface OmpReference {
	file: string;
	specifier: string;
}

/** Every runtime omp reference in production code under `root` (repo-relative, forward-slash file paths). */
export function scanOmpReferences(root: string): OmpReference[] {
	const refs: OmpReference[] = [];
	for (const file of productionFiles(root)) {
		if (file.startsWith(OMP_ADAPTER_DIR) || file === OMP_PACKAGE_FILE) continue;
		const text = readFileSync(path.join(root, file), "utf8");
		if (!/@oh-my-pi\/|\/omp\/|mpModule|omp-package/.test(text)) continue;
		for (const specifier of ompSpecifiers(file, text)) refs.push({ file, specifier });
	}
	return refs.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
}
