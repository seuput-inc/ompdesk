/**
 * omp import lint — production code loads a stock omp module only through the omp layer.
 *
 * Every omp module OMPdesk loads is internal (no semver), so an omp update that moves or renames one breaks the
 * code that imports it. The layer keeps that code in one known place:
 * - bridge code running inside omp imports `resources/gui-bridge/omp/<subpath>.ts`, a one-line
 *   `export * from "@oh-my-pi/<subpath>"` adapter (omp rewrites it onto its own module like a direct import; a renamed
 *   export gets a named shim line under the star);
 * - the processes outside omp (stock helper workers, stats host, boot model) load a module by its literal key through
 *   `resources/gui-bridge/omp-package.ts`;
 * - `health.ts` (the probe's loaders) and `capabilities.ts` (its requirement table) name specifiers literally.
 * Anywhere else in `SCANNED_ROOTS` a runtime `@oh-my-pi/*` reference fails, except the package name main and the
 * scripts hold as data to install omp or read its version (`PACKAGE_NAME_DATA`, never a call argument or an import).
 * Type-only imports are erased at runtime and stay direct. There is no `-ok` marker: the layer is the exception.
 *
 * `scripts/omp-boundary/scan.ts` reads references with the same walker, so the touchpoint registry and this lint agree.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import ts from "@typescript/typescript6";

/** The directories production code lives in (repo-relative). */
export const SCANNED_ROOTS = ["src", "resources/gui-bridge", "scripts"];
export const OMP_ADAPTER_DIR = "resources/gui-bridge/omp/";
export const OMP_PACKAGE_FILE = "resources/gui-bridge/omp-package.ts";

const OMP_SCOPE = "@oh-my-pi/";
const SPECIFIER = /^@oh-my-pi\/[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test-[^/]*$)/;
/** Files that name stock specifiers literally besides the adapters: the probe's loaders and its requirement table. */
const PROBE_FILES = new Set(["resources/gui-bridge/health.ts", "resources/gui-bridge/capabilities.ts"]);
/** Processes outside omp: they load stock through omp-package.ts, never through an adapter (scripts/omp-bump reads any omp tree). */
const OUTSIDE_OMP = [
	"scripts/omp-bump/",
	"resources/gui-bridge/stock-helper/",
	"resources/gui-bridge/stats-host.ts",
	"resources/gui-bridge/boot-model.ts",
];
/** Package names production code may hold as data (installing omp, reading its version), never to load a module. */
const PACKAGE_NAME_DATA = new Set(["@oh-my-pi/pi-coding-agent"]);
const PACKAGE_CALLS = new Set(["loadOmpModule", "ompModuleFile"]);

/**
 * A file that is not production code: a test, an e2e spec, a `test-*` helper, the boundary tooling (this lint, whose
 * rules name package strings, and scripts/omp-boundary).
 * @param {string} file repo-relative, forward slashes
 */
export function isTestOrTooling(file) {
	return TEST_FILE.test(file) || file.startsWith("scripts/omp-boundary/") || file === "scripts/lint-omp-imports.mjs";
}

/**
 * Production source files under `SCANNED_ROOTS`, repo-relative with forward slashes.
 * @param {string} root
 * @returns {string[]}
 */
export function productionFiles(root) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} dir */
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (SOURCE_FILE.test(entry.name)) {
				const file = path.relative(root, full).split(path.sep).join("/");
				if (!isTestOrTooling(file)) out.push(file);
			}
		}
	};
	for (const dir of SCANNED_ROOTS) walk(path.join(root, dir));
	return out.sort();
}

/**
 * The stock specifier an adapter file stands for, or undefined when `repoPath` is no adapter.
 * @param {string} repoPath
 */
export function adapterSpecifier(repoPath) {
	if (!repoPath.startsWith(OMP_ADAPTER_DIR) || !repoPath.endsWith(".ts")) return undefined;
	return OMP_SCOPE + repoPath.slice(OMP_ADAPTER_DIR.length, -".ts".length);
}

/**
 * The adapter file of a stock specifier.
 * @param {string} specifier
 */
export function adapterPath(specifier) {
	return `${OMP_ADAPTER_DIR}${specifier.slice(OMP_SCOPE.length)}.ts`;
}

/** @param {string} file */
function scriptKind(file) {
	if (file.endsWith("x")) return file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
	return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** @param {ts.Node} node */
function inTypePosition(node) {
	for (let n = node.parent; n; n = n.parent) {
		if (ts.isTypeNode(n)) return true;
		if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return false;
	}
	return false;
}

/** @param {ts.ImportDeclaration} node */
function erasedImport(node) {
	const clause = node.importClause;
	if (!clause) return false;
	if (clause.isTypeOnly) return true;
	if (clause.name) return false;
	const bindings = clause.namedBindings;
	return (
		!!bindings &&
		ts.isNamedImports(bindings) &&
		bindings.elements.length > 0 &&
		bindings.elements.every(e => e.isTypeOnly)
	);
}

/**
 * `const NAME = "text"` anywhere in the file: what a `${NAME}/subpath` template resolves to.
 * @param {ts.SourceFile} source
 */
function stringConstants(source) {
	/** @type {Map<string, string>} */
	const constants = new Map();
	/** @param {ts.Node} node */
	const collect = node => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.initializer &&
			ts.isStringLiteral(node.initializer)
		) {
			constants.set(node.name.text, node.initializer.text);
		}
		ts.forEachChild(node, collect);
	};
	collect(source);
	return constants;
}

/**
 * @param {ts.TemplateExpression} node
 * @param {ReadonlyMap<string, string>} constants
 */
function templateText(node, constants) {
	let text = node.head.text;
	for (const span of node.templateSpans) {
		if (!ts.isIdentifier(span.expression)) return undefined;
		const value = constants.get(span.expression.text);
		if (value === undefined) return undefined;
		text += value + span.literal.text;
	}
	return text;
}

/**
 * Whether a string node is where a module is named for loading: an import/export's module, or any call's argument
 * (`import()`, `require`, `Bun.resolveSync`, a local loader).
 * @param {ts.Node} node
 */
function loadingPosition(node) {
	const parent = node.parent;
	if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node)
		return true;
	return ts.isCallExpression(parent) && parent.arguments.includes(/** @type {ts.Expression} */ (node));
}

/** A call that loads or resolves a module by its argument: `import()`, `require`, `Bun.resolveSync`, `load…`. */
const LOADER_NAME = /require|resolve|import|load/i;

/** @param {ts.CallExpression} node */
function loaderCall(node) {
	const callee = node.expression;
	if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
	const name = ts.isIdentifier(callee)
		? callee.text
		: ts.isPropertyAccessExpression(callee)
			? callee.name.text
			: undefined;
	return name !== undefined && LOADER_NAME.test(name);
}

/**
 * The relative module a runtime import, re-export or `import()` names, or undefined.
 * @param {ts.Node} node
 */
function runtimeRelativeModule(node) {
	if (ts.isImportDeclaration(node) && !erasedImport(node) && ts.isStringLiteral(node.moduleSpecifier))
		return node.moduleSpecifier.text.startsWith(".") ? node.moduleSpecifier.text : undefined;
	if (
		ts.isExportDeclaration(node) &&
		!node.isTypeOnly &&
		node.moduleSpecifier &&
		ts.isStringLiteral(node.moduleSpecifier)
	)
		return node.moduleSpecifier.text.startsWith(".") ? node.moduleSpecifier.text : undefined;
	if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !inTypePosition(node)) {
		const arg = node.arguments[0];
		if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && arg.text.startsWith("."))
			return arg.text;
	}
	return undefined;
}

/**
 * @param {string} repoPath
 * @param {string} relative
 */
function resolveRelative(repoPath, relative) {
	const joined = path.posix.normalize(path.posix.join(path.posix.dirname(repoPath), relative));
	return joined.endsWith(".ts") ? joined : `${joined}.ts`;
}

/**
 * @typedef {{
 *   specifier: string | null;
 *   line: number;
 *   via: "direct" | "adapter" | "package" | "package-import";
 *   data?: boolean;
 * }} OmpReference
 * `direct`: a `@oh-my-pi/*` string at runtime (`data`: outside an import and every call's arguments);
 * `adapter`: a runtime import of an adapter, `specifier` the stock module it reaches;
 * `package`: a `loadOmpModule`/`ompModuleFile` call, `specifier` `@oh-my-pi/<key>` or null for a non-literal key;
 * `package-import`: a runtime import of omp-package.ts (`specifier` null).
 */

/** Text every kind of reference contains; a file without any is not parsed (most of the ~1500 production files). */
const REFERENCE_HINT = /@oh-my-pi\/|\/omp\/|mpModule|omp-package/;

/**
 * Every omp reference in one source text.
 * @param {string} repoPath repo-relative, forward slashes
 * @param {string} text
 * @returns {OmpReference[]}
 */
export function ompReferences(repoPath, text) {
	if (!REFERENCE_HINT.test(text)) return [];
	const source = ts.createSourceFile(repoPath, text, ts.ScriptTarget.ES2022, true, scriptKind(repoPath));
	const constants = stringConstants(source);
	/** @type {OmpReference[]} */
	const found = [];
	/** @param {ts.Node} node */
	const lineOf = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
	/** @param {ts.Node} node */
	const visit = node => {
		if (ts.isImportDeclaration(node) && erasedImport(node)) return;
		if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
		if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return;
		const relative = runtimeRelativeModule(node);
		if (relative !== undefined) {
			const target = resolveRelative(repoPath, relative);
			const stock = adapterSpecifier(target);
			if (stock) found.push({ specifier: stock, line: lineOf(node), via: "adapter" });
			else if (target === OMP_PACKAGE_FILE)
				found.push({ specifier: null, line: lineOf(node), via: "package-import" });
		}
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && PACKAGE_CALLS.has(node.expression.text)) {
			const arg = node.arguments[0];
			const key = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
			found.push({ specifier: key === null ? null : OMP_SCOPE + key, line: lineOf(node), via: "package" });
		}
		// A file-local constant handed to a loader (`const P = "@oh-my-pi/…"; import(P)`) is no longer data.
		if (ts.isCallExpression(node) && loaderCall(node)) {
			for (const arg of node.arguments) {
				const value = ts.isIdentifier(arg) ? constants.get(arg.text) : undefined;
				if (value !== undefined && SPECIFIER.test(value))
					found.push({ specifier: value, line: lineOf(arg), via: "direct", data: false });
			}
		}
		/** @type {string | undefined} */
		let specifier;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) specifier = node.text;
		else if (ts.isTemplateExpression(node)) specifier = templateText(node, constants);
		if (specifier !== undefined && SPECIFIER.test(specifier) && !inTypePosition(node))
			found.push({ specifier, line: lineOf(node), via: "direct", data: !loadingPosition(node) });
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/**
 * The stock specifiers one source text reaches at runtime: directly, through an adapter or an omp-package key.
 * @param {string} repoPath
 * @param {string} text
 */
export function ompSpecifiers(repoPath, text) {
	const found = new Set();
	for (const ref of ompReferences(repoPath, text)) if (ref.specifier !== null) found.add(ref.specifier);
	return [...found].sort();
}

/** @param {string} repoPath */
const isOutsideOmp = repoPath => OUTSIDE_OMP.some(prefix => repoPath === prefix || repoPath.startsWith(prefix));

/**
 * Places in one production file that load an omp module outside the layer.
 * @param {string} repoPath repo-relative, forward slashes
 * @param {string} source
 * @returns {{ line: number; text: string }[]}
 */
export function findOmpImportViolations(repoPath, source) {
	const refs = ompReferences(repoPath, source);
	/** @type {{ line: number; text: string }[]} */
	const found = [];
	const own = adapterSpecifier(repoPath);
	if (own) {
		for (const ref of refs)
			if (ref.via === "direct" && ref.specifier !== own)
				found.push({ line: ref.line, text: `adapter names ${ref.specifier}, not its own ${own}` });
		const file = ts.createSourceFile(repoPath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
		const star = file.statements.some(
			s =>
				ts.isExportDeclaration(s) &&
				!s.exportClause &&
				!s.isTypeOnly &&
				s.moduleSpecifier !== undefined &&
				ts.isStringLiteral(s.moduleSpecifier) &&
				s.moduleSpecifier.text === own,
		);
		if (!star) found.push({ line: 1, text: `adapter lacks export * from "${own}"` });
		return found;
	}
	if (PROBE_FILES.has(repoPath)) return found;
	const packageFile = repoPath === OMP_PACKAGE_FILE;
	const outside = isOutsideOmp(repoPath);
	const inBridge = repoPath.startsWith("resources/gui-bridge/");
	for (const ref of refs) {
		if (ref.via === "direct") {
			if (packageFile || (ref.data && ref.specifier !== null && PACKAGE_NAME_DATA.has(ref.specifier))) continue;
			const route = outside
				? "load it with omp-package.ts"
				: inBridge
					? `import ${adapterPath(ref.specifier ?? "")}`
					: "only the gui-bridge loads omp modules";
			found.push({ line: ref.line, text: `omp module outside the layer ${ref.specifier} (${route})` });
		} else if (ref.via === "adapter" && (outside || !inBridge)) {
			found.push({
				line: ref.line,
				text: `adapter ${ref.specifier} imported outside omp's process (use omp-package.ts there)`,
			});
		} else if ((ref.via === "package" || ref.via === "package-import") && !packageFile && !outside) {
			found.push({
				line: ref.line,
				text: `omp-package.ts is for processes outside omp; import ${ref.specifier ? adapterPath(ref.specifier) : `${OMP_ADAPTER_DIR}<subpath>.ts`} instead`,
			});
		} else if (ref.via === "package" && ref.specifier === null && !packageFile) {
			found.push({ line: ref.line, text: "loadOmpModule/ompModuleFile needs a literal key" });
		}
	}
	return found;
}
