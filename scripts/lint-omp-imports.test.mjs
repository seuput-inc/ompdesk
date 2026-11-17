import { describe, expect, it } from "vitest";
import { adapterPath, adapterSpecifier, findOmpImportViolations, ompReferences } from "./lint-omp-imports.mjs";

/** @param {string} file @param {string} source */
const lines = (file, source) => findOmpImportViolations(file, source).map(hit => hit.line);

describe("adapter paths", () => {
	it("mirror the stock specifier under resources/gui-bridge/omp", () => {
		for (const [specifier, file] of [
			["@oh-my-pi/pi-ai", "resources/gui-bridge/omp/pi-ai.ts"],
			["@oh-my-pi/pi-coding-agent/config/registry", "resources/gui-bridge/omp/pi-coding-agent/config/registry.ts"],
		]) {
			expect(adapterPath(specifier)).toBe(file);
			expect(adapterSpecifier(file)).toBe(specifier);
		}
		expect(adapterSpecifier("resources/gui-bridge/health.ts")).toBeUndefined();
	});
});

describe("ompReferences", () => {
	it("names each kind of reference with its line", () => {
		const source = [
			'import { a } from "@oh-my-pi/pi-utils";',
			'import { b } from "../omp/pi-ai";',
			'const c = await import("../omp/pi-coding-agent/judgment");',
			'const d = await loadOmpModule("pi-natives", "grep");',
			"const e = ompModuleFile(name);",
			'import { f } from "../omp-package";',
			'const g = "@oh-my-pi/pi-coding-agent";',
		].join("\n");
		expect(
			ompReferences("resources/gui-bridge/modes/x.ts", source).map(({ specifier, line, via, data }) => ({
				specifier,
				line,
				via,
				...(data === undefined ? {} : { data }),
			})),
		).toEqual([
			{ specifier: "@oh-my-pi/pi-utils", line: 1, via: "direct", data: false },
			{ specifier: "@oh-my-pi/pi-ai", line: 2, via: "adapter" },
			{ specifier: "@oh-my-pi/pi-coding-agent/judgment", line: 3, via: "adapter" },
			{ specifier: "@oh-my-pi/pi-natives", line: 4, via: "package" },
			{ specifier: null, line: 5, via: "package" },
			{ specifier: null, line: 6, via: "package-import" },
			{ specifier: "@oh-my-pi/pi-coding-agent", line: 7, via: "direct", data: true },
		]);
	});

	it("skips type-only imports of adapters and of stock", () => {
		const source = 'import type { A } from "../omp/pi-ai";\nimport type { B } from "@oh-my-pi/pi-ai";';
		expect(ompReferences("resources/gui-bridge/modes/x.ts", source)).toEqual([]);
	});
});

describe("findOmpImportViolations", () => {
	it("refuses a stock import in bridge code and accepts its adapter and type-only imports", () => {
		const file = "resources/gui-bridge/modes/x.ts";
		expect(lines(file, 'import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";')).toEqual([1]);
		expect(lines(file, 'const m = await import("@oh-my-pi/pi-ai");')).toEqual([1]);
		expect(findOmpImportViolations(file, 'import { x } from "@oh-my-pi/pi-utils";')[0]?.text).toBe(
			"omp module outside the layer @oh-my-pi/pi-utils (import resources/gui-bridge/omp/pi-utils.ts)",
		);
		expect(lines(file, 'import { lookup } from "../omp/pi-coding-agent/config/registry";')).toEqual([]);
		expect(lines(file, 'import type { AgentSession } from "@oh-my-pi/pi-coding-agent";')).toEqual([]);
	});

	it("refuses an omp module in main and the scripts, but keeps the package name held as data", () => {
		const file = "src/main/x.ts";
		expect(lines(file, 'import { getWorktreesDir } from "@oh-my-pi/pi-utils";')).toEqual([1]);
		expect(lines(file, 'const m = require("@oh-my-pi/pi-coding-agent");')).toEqual([1]);
		expect(lines(file, 'Bun.resolveSync("@oh-my-pi/pi-coding-agent", root);')).toEqual([1]);
		expect(lines(file, 'const OTHER = "@oh-my-pi/pi-utils";')).toEqual([1]);
		expect(lines(file, 'import { lookup } from "../../resources/gui-bridge/omp/pi-ai";')).toEqual([1]);
		expect(
			lines(
				file,
				'export const OMP_PACKAGE = "@oh-my-pi/pi-coding-agent";\nif (manifest.name === "@oh-my-pi/pi-coding-agent") ok();',
			),
		).toEqual([]);
		expect(lines("scripts/x.ts", 'await import("@oh-my-pi/pi-coding-agent/sdk");')).toEqual([1]);
	});

	it("refuses the package name once a file-local constant hands it to a loader, and keeps it as a path part", () => {
		const file = "src/main/x.ts";
		const held = 'const P = "@oh-my-pi/pi-coding-agent";\n';
		expect(lines(file, `${held}await import(P);`)).toEqual([2]);
		expect(lines(file, `${held}const m = require(P);`)).toEqual([2]);
		expect(lines(file, `${held}Bun.resolveSync(P, root);`)).toEqual([2]);
		expect(lines(file, `${held}const sdk = await loadPackage(P);`)).toEqual([2]);
		expect(lines(file, `${held}const manifest = join(root, "node_modules", P, "package.json");`)).toEqual([]);
	});

	it("sends processes outside omp through omp-package keys", () => {
		const file = "resources/gui-bridge/stock-helper/x.ts";
		expect(lines(file, 'import(Bun.resolveSync("@oh-my-pi/pi-natives", root));')).toEqual([1]);
		expect(lines(file, 'import { x } from "../omp/pi-natives";')).toEqual([1]);
		expect(lines(file, "loadOmpModule(name);")).toEqual([1]);
		expect(
			lines(file, 'import { loadOmpModule } from "../omp-package";\nawait loadOmpModule("pi-natives", "grep");'),
		).toEqual([]);
	});

	it("keeps omp-package.ts to the processes outside omp", () => {
		const file = "resources/gui-bridge/settings.ts";
		expect(lines(file, 'import { loadOmpModule } from "./omp-package";')).toEqual([1]);
		expect(lines(file, 'await loadOmpModule("pi-ai");')).toEqual([1]);
	});

	it("holds an adapter to one star re-export of its own module, shims allowed", () => {
		const file = "resources/gui-bridge/omp/pi-coding-agent/config/registry.ts";
		const own = '"@oh-my-pi/pi-coding-agent/config/registry"';
		expect(lines(file, `export * from ${own};`)).toEqual([]);
		expect(lines(file, `export * from ${own};\nexport { lookup as find } from ${own};`)).toEqual([]);
		expect(lines(file, `export { lookup } from ${own};`)).toEqual([1]);
		expect(lines(file, `export * from ${own};\nexport * from "@oh-my-pi/pi-utils";`)).toEqual([2]);
	});

	it("lets the probe name its modules literally", () => {
		const loader = 'const L = { "@oh-my-pi/pi-ai": () => import("@oh-my-pi/pi-ai") };';
		expect(lines("resources/gui-bridge/health.ts", loader)).toEqual([]);
		expect(lines("resources/gui-bridge/capabilities.ts", loader)).toEqual([]);
	});
});
