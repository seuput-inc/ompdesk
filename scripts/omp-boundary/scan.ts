/**
 * Where OMPdesk's production code names a stock omp module. A reference is a runtime `import`/`export … from`,
 * a dynamic `import("…")`, `require("…")`, or a string literal that is exactly a module specifier (the
 * `Bun.resolveSync("…")`, `importFromOmp("…")` and `LOADERS` forms that load omp's modules without a static import),
 * or a template that only joins such a file-local constant with a literal (`${AGENT}/discovery`).
 * `import type`, all-`type` named imports and `import("…")` inside a type position are erased at runtime, so they
 * are not references. Comments are not nodes, so they never count.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface OmpReference {
	file: string;
	specifier: string;
}

/** The directories production code lives in. */
export const SCANNED_ROOTS = ["src", "resources/gui-bridge", "scripts"] as const;

const SPECIFIER = /^@oh-my-pi\/[a-z][a-z0-9-]*(?:\/[A-Za-z0-9._/-]+)?$/;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /(?:\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test-[^/]*$)/;

/** A file that is not production code: a test, an e2e spec, a `test-*` helper, this folder's own tooling. */
export function isTestOrTooling(file: string): boolean {
	return TEST_FILE.test(file) || file.startsWith("scripts/omp-boundary/");
}

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (SOURCE_FILE.test(entry.name)) out.push(full);
	}
}

function scriptKind(file: string): ts.ScriptKind {
	if (file.endsWith("x")) return file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
	return /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function inTypePosition(node: ts.Node): boolean {
	for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
		if (ts.isTypeNode(n)) return true;
		if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return false;
	}
	return false;
}

function erasedImport(node: ts.ImportDeclaration): boolean {
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

/** `const NAME = "text"` anywhere in the file: what a `${NAME}/subpath` template resolves to. */
function stringConstants(source: ts.SourceFile): Map<string, string> {
	const constants = new Map<string, string>();
	const collect = (node: ts.Node): void => {
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

function templateText(node: ts.TemplateExpression, constants: ReadonlyMap<string, string>): string | undefined {
	let text = node.head.text;
	for (const span of node.templateSpans) {
		if (!ts.isIdentifier(span.expression)) return undefined;
		const value = constants.get(span.expression.text);
		if (value === undefined) return undefined;
		text += value + span.literal.text;
	}
	return text;
}

/** The `@oh-my-pi/*` specifiers one source text references at runtime. */
export function ompSpecifiers(file: string, text: string): string[] {
	const found = new Set<string>();
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKind(file));
	const constants = stringConstants(source);
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && erasedImport(node)) return;
		if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
		if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) return;
		let specifier: string | undefined;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) specifier = node.text;
		else if (ts.isTemplateExpression(node)) specifier = templateText(node, constants);
		if (specifier !== undefined && SPECIFIER.test(specifier) && !inTypePosition(node)) found.add(specifier);
		ts.forEachChild(node, visit);
	};
	visit(source);
	return [...found].sort();
}

/** Every runtime omp reference in production code under `root` (repo-relative, forward-slash file paths). */
export function scanOmpReferences(root: string): OmpReference[] {
	const files: string[] = [];
	for (const dir of SCANNED_ROOTS) walk(path.join(root, dir), files);
	const refs: OmpReference[] = [];
	for (const abs of files) {
		const file = path.relative(root, abs).split(path.sep).join("/");
		if (isTestOrTooling(file)) continue;
		const text = readFileSync(abs, "utf8");
		if (!text.includes("@oh-my-pi/")) continue;
		for (const specifier of ompSpecifiers(file, text)) refs.push({ file, specifier });
	}
	return refs.sort((a, b) => a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier));
}
