import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { REQUIREMENTS } from "../../resources/gui-bridge/capabilities";
import { OMP_PACKAGE_MODULES } from "../../resources/gui-bridge/omp-package";
import {
	adapterSpecifier,
	OMP_PACKAGE_FILE,
	ompReferences,
	ompSpecifiers,
	productionFiles,
} from "../lint-omp-imports.mjs";
import { scanOmpReferences } from "./scan";
import { TOUCHPOINTS, type Touchpoint, type TouchpointArea } from "./touchpoints";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const AREA_OF_PREFIX: Readonly<Record<string, TouchpointArea>> = {
	L: "launch",
	Q: "rpc",
	B: "bridge",
	H: "helper",
	U: "settings",
	F: "files",
	C: "copy",
};

const IN_MEMORY_PATCHES = ["B05", "B14", "B18", "B50", "B52", "B60"];

function byId(id: string): Touchpoint {
	const found = TOUCHPOINTS.find(t => t.id === id);
	if (!found) throw new Error(`no touchpoint ${id}`);
	return found;
}

function stockTests(): string[] {
	const found: string[] = [];
	for (const dir of ["src", "e2e", "scripts", "resources"]) {
		for (const entry of readdirSync(path.join(ROOT, dir), { recursive: true })) {
			const file = String(entry).split(path.sep).join("/");
			if (file.includes("node_modules/")) continue;
			if (/-stock\.(?:test|e2e)\.[cm]?[jt]sx?$/.test(file)) found.push(`${dir}/${file}`);
		}
	}
	return found.sort();
}

describe("omp touchpoint registry", () => {
	it("has unique ids of the form L|Q|B|H|U|F|C plus two digits, in the area their letter names", () => {
		const ids = TOUCHPOINTS.map(t => t.id);
		expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
		for (const t of TOUCHPOINTS) {
			expect(t.id, t.id).toMatch(/^(L|Q|B|H|U|F|C)\d{2}$/);
			expect(t.area, t.id).toBe(AREA_OF_PREFIX[t.id[0]]);
			expect(["public", "internal"], t.id).toContain(t.contract);
			expect(t.summary.trim(), t.id).not.toBe("");
			expect(t.summary, t.id).not.toContain("\n");
			expect(t.files.length, `${t.id} lists no file`).toBeGreaterThan(0);
		}
	});

	it("lists only repo paths that exist, without globs", () => {
		const missing: string[] = [];
		for (const t of TOUCHPOINTS) {
			for (const file of [...t.files, ...t.tests]) {
				if (file.includes("*") || !existsSync(path.join(ROOT, file))) missing.push(`${t.id}: ${file}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it("names the in-memory patches of omp objects in their summary", () => {
		for (const id of IN_MEMORY_PATCHES) expect(byId(id).summary, id).toMatch(/^In-memory monkey patch/);
	});

	it("has a listed file and a listed specifier for every runtime @oh-my-pi reference in production code", () => {
		const unlisted = scanOmpReferences(ROOT)
			.filter(ref => !TOUCHPOINTS.some(t => t.files.includes(ref.file) && t.stock.includes(ref.specifier)))
			.map(ref => {
				const owners = TOUCHPOINTS.filter(t => t.files.includes(ref.file)).map(t => t.id);
				return `${ref.file} names ${ref.specifier}${owners.length ? `, listed by ${owners.join(",")} without it in stock` : ", in no touchpoint's files"}`;
			});
		expect(unlisted, "add the file and the specifier to a touchpoint in scripts/omp-boundary/touchpoints.ts").toEqual(
			[],
		);
	});

	it("lists every module capabilities.ts requires in some stock", () => {
		const listed = new Set(TOUCHPOINTS.flatMap(t => t.stock));
		const required = Object.values(REQUIREMENTS).flatMap(r => Object.keys(r.modules ?? {}));
		expect(required.length).toBeGreaterThan(0);
		expect([...new Set(required)].filter(spec => !listed.has(spec))).toEqual([]);
	});

	it("lists every *-stock test as the guard of some touchpoint", () => {
		const guarded = new Set(TOUCHPOINTS.flatMap(t => t.tests));
		const found = stockTests();
		expect(found.length).toBeGreaterThan(0);
		expect(found.filter(file => !guarded.has(file))).toEqual([]);
	});

	it("names the stock counterpart of every copy", () => {
		const copies = TOUCHPOINTS.filter(t => t.area === "copy");
		expect(copies.length).toBeGreaterThan(0);
		for (const t of copies) {
			expect(t.stock.length, `${t.id} names no stock module`).toBeGreaterThan(0);
			const counterpart = t.stock[0].split("/").pop() ?? "";
			expect(t.summary, t.id).toContain(counterpart);
			expect(t.summary, t.id).toMatch(/\bstock\b|\bTUI\b/);
		}
	});

	it("says what becomes of every copy, and only of copies; a kept copy that its tests pin has tests", () => {
		for (const t of TOUCHPOINTS) {
			if (t.area !== "copy") {
				expect(t.disposition, t.id).toBeUndefined();
				continue;
			}
			expect(t.disposition?.reason, `${t.id} has no disposition`).toMatch(/\S/);
			if (t.disposition?.kind === "registered") expect(t.tests.length, t.id).toBeGreaterThan(0);
		}
	});

	it("loads every omp-package module by a listed key, and lists only keys something loads", () => {
		const keys: Array<string | null> = [];
		for (const file of productionFiles(ROOT)) {
			if (file === OMP_PACKAGE_FILE) continue;
			for (const ref of ompReferences(file, readFileSync(path.join(ROOT, file), "utf8")))
				if (ref.via === "package")
					keys.push(ref.specifier === null ? null : ref.specifier.slice("@oh-my-pi/".length));
		}
		const listed = new Set<string>(OMP_PACKAGE_MODULES);
		expect(keys.filter(key => key === null || !listed.has(key))).toEqual([]);
		expect([...listed].filter(key => !keys.includes(key))).toEqual([]);
	});

	it("has no adapter that no production file imports", () => {
		const files = productionFiles(ROOT);
		const imported = new Set(
			files.flatMap(file =>
				ompReferences(file, readFileSync(path.join(ROOT, file), "utf8"))
					.filter(ref => ref.via === "adapter")
					.map(ref => ref.specifier),
			),
		);
		const adapters = files
			.map(file => adapterSpecifier(file))
			.filter((specifier): specifier is string => specifier !== undefined);
		expect(adapters.length).toBeGreaterThan(0);
		expect(adapters.filter(specifier => !imported.has(specifier))).toEqual([]);
	});
});

describe("ompSpecifiers", () => {
	const scan = (text: string, file = "probe.ts") => ompSpecifiers(file, text);

	it("counts static, dynamic, require and literal-loader references", () => {
		const text = `
			import { a } from "@oh-my-pi/pi-utils";
			import * as b from "@oh-my-pi/pi-ai/oauth";
			export { c } from "@oh-my-pi/pi-tui/theme";
			const d = await import("@oh-my-pi/pi-coding-agent/config/registry");
			const e = require("@oh-my-pi/pi-natives");
			const f = Bun.resolveSync("@oh-my-pi/pi-catalog/types", root);
		`;
		expect(scan(text)).toEqual([
			"@oh-my-pi/pi-ai/oauth",
			"@oh-my-pi/pi-catalog/types",
			"@oh-my-pi/pi-coding-agent/config/registry",
			"@oh-my-pi/pi-natives",
			"@oh-my-pi/pi-tui/theme",
			"@oh-my-pi/pi-utils",
		]);
	});

	it("skips what is erased at runtime and what is only text", () => {
		const text = `
			import type { A } from "@oh-my-pi/pi-coding-agent";
			import { type B, type C } from "@oh-my-pi/pi-ai";
			export type { D } from "@oh-my-pi/pi-tui";
			type E = import("@oh-my-pi/pi-utils").F;
			const g = x as typeof import("@oh-my-pi/pi-agent-core");
			// import("@oh-my-pi/pi-natives")
			/** \`@oh-my-pi/pi-catalog/types\` */
			const h = "@oh-my-pi/pi-coding-agent is the package";
			const i = "@oh-my-pi/";
		`;
		expect(scan(text)).toEqual([]);
	});

	it("keeps a value import that sits next to type imports", () => {
		expect(scan(`import { type A, B } from "@oh-my-pi/pi-utils";`)).toEqual(["@oh-my-pi/pi-utils"]);
		expect(scan(`import "@oh-my-pi/pi-natives";`)).toEqual(["@oh-my-pi/pi-natives"]);
	});

	it("joins a file-local constant with a literal in a template", () => {
		const text = `
			const AGENT = "@oh-my-pi/pi-coding-agent";
			const spec = \`\${AGENT}/discovery/helpers\`;
			const other = \`\${unknown}/x\`;
		`;
		expect(scan(text)).toEqual(["@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-coding-agent/discovery/helpers"]);
	});

	it("reads tsx", () => {
		expect(
			scan(`import { x } from "@oh-my-pi/pi-tui/tools/todo"; export const y = <div>{x}</div>;`, "probe.tsx"),
		).toEqual(["@oh-my-pi/pi-tui/tools/todo"]);
	});

	it("reads an adapter import as the stock module it re-exports", () => {
		expect(
			scan(
				'import { lookup } from "../omp/pi-coding-agent/config/registry";',
				"resources/gui-bridge/modes/probe.ts",
			),
		).toEqual(["@oh-my-pi/pi-coding-agent/config/registry"]);
		expect(scan('const m = await import("./omp/pi-ai");', "resources/gui-bridge/probe.ts")).toEqual([
			"@oh-my-pi/pi-ai",
		]);
	});

	it("reads an omp-package key as @oh-my-pi/<key>", () => {
		expect(
			scan('await loadOmpModule("pi-ai", "x"); ompModuleFile(name);', "resources/gui-bridge/stock-helper/probe.ts"),
		).toEqual(["@oh-my-pi/pi-ai"]);
	});
});
