/**
 * The tables `ompdesk_app` keeps in Rust against the captured TypeScript tables the core's tests replay
 * (`native/ompdesk/crates/core/src/agentctl/app/captured/meta.json`, `agentctl::app::tests`), by name and order:
 * the channels, the panel tabs, view sheets and settings sections, the settings rows. A merge that puts a row in a
 * different place on one side fails `cargo test` on CI only, twenty minutes later; this reads the sources as text and
 * fails in a second, so the pre-push gate and `check:changed` run it when a change touches either side.
 * The rest of what the Rust tests compare (tiers, describers, guard and validation replays) needs the Rust code and
 * stays with `cargo test`.
 *
 *   bun scripts/check-captured-tables.ts [<commit>]   the working tree, or the files as `<commit>` holds them
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { withoutGitSelectors } from "../src/shared/git-env";

const APP = "native/ompdesk/crates/core/src/agentctl/app";
const META = `${APP}/captured/meta.json`;

/** The files whose change can make the Rust tables and `meta.json` disagree. */
export const CAPTURED_TABLE_INPUT = new RegExp(
	`^${APP}/(?:captured/meta\\.json|catalog\\.rs|channels\\.rs|settings\\.rs)$`,
);

/** The string literals of a `[&str; N]` constant, in order. */
function stringList(source: string, name: string): string[] {
	const body = new RegExp(`pub (?:const|static) ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
	if (body === undefined) throw new Error(`${name} not found`);
	return [...body.matchAll(/"([^"]*)"/g)].map(match => match[1] ?? "");
}

/** The first string of every row in a table that runs from `start` to `end` (rows start at `indent`). */
function rowNames(source: string, start: string, end: string, row: RegExp): string[] {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from);
	if (from < 0 || to < 0) throw new Error(`${start} not found`);
	return [...source.slice(from, to).matchAll(row)].map(match => match[1] ?? "");
}

function difference(table: string, rust: string[], captured: string[]): string | null {
	const at = rust.findIndex((name, index) => name !== captured[index]);
	if (at < 0 && rust.length === captured.length) return null;
	const index = at < 0 ? rust.length : at;
	return `${table}: Rust has ${rust.length}, ${META} has ${captured.length}; first difference at #${index}: Rust ${JSON.stringify(rust[index] ?? null)}, captured ${JSON.stringify(captured[index] ?? null)}`;
}

/** Every table on which the Rust sources and `meta.json` disagree; `read` gets a repository-relative path. */
export function tableMismatches(read: (file: string) => string): string[] {
	const meta = JSON.parse(read(META)) as {
		panelTabs: string[];
		viewSheets: string[];
		settingsSections: string[];
		settings: Array<{ id: string }>;
		channels: Record<string, unknown>;
	};
	const catalog = read(`${APP}/catalog.rs`);
	const channels = rowNames(read(`${APP}/channels.rs`), "pub static CHANNELS", "\n];", /^ {4}\(\s*"([^"]+)"/gm);
	const settings = rowNames(
		read(`${APP}/settings.rs`),
		"pub static SETTINGS",
		"\n});",
		/^ {8}[a-z_]+\(\s*"([^"]+)"/gm,
	);
	return [
		difference("PANEL_TABS", stringList(catalog, "PANEL_TABS"), meta.panelTabs),
		difference("VIEW_SHEETS", stringList(catalog, "VIEW_SHEETS"), meta.viewSheets),
		difference("SETTINGS_SECTIONS", stringList(catalog, "SETTINGS_SECTIONS"), meta.settingsSections),
		difference(
			"SETTINGS",
			settings,
			meta.settings.map(row => row.id),
		),
		difference("CHANNELS", channels, Object.keys(meta.channels)),
	].filter(problem => problem !== null);
}

if (import.meta.main) {
	const commit = process.argv[2];
	const read = commit
		? (file: string) =>
				execFileSync("git", ["show", `${commit}:${file}`], {
					encoding: "utf8",
					env: withoutGitSelectors(process.env),
				})
		: (file: string) => fs.readFileSync(file, "utf8");
	const problems = tableMismatches(read);
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) {
		console.error(
			"The Rust table and the captured one must list the same rows in the same order (agentctl::app::tests).",
		);
		process.exit(1);
	}
	console.log("captured tables: the Rust tables and meta.json agree");
}
