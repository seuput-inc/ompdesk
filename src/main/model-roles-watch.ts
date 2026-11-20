/**
 * One `model-roles` line in gui-runtime.jsonl per change of `modelRoles` in omp's config.yml, whoever wrote it: an omp's
 * own settings save (any tab, any setting change), OMPdesk's `set_model_role`, a tool's file write, a terminal omp, an
 * editor. Each line names the roles that changed (`slow: a → b`) and the pids of the omps this app ran at that moment
 * (`omp-pids.json`; each omp log line carries its pid), so a role that changes under the person is attributable.
 * 20 Nov 2026 (C16): on one computer slow and advisor went back to values from two days earlier, and no log anywhere
 * named the writer. Values are role ids and model strings only; nothing else of the file is logged.
 */
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/** Role id → the value config.yml holds for it. */
export type RoleValues = Readonly<Record<string, string>>;

/** The quiet period after the last event of the config file before it is read (a save is a temp write and a rename). */
const SETTLE_MS = 300;

/** The part of config.yml read here: `modelRoles`, string values only (anything else in the file passes). */
const ConfigRoles = z.object({ modelRoles: z.record(z.unknown()).optional() }).passthrough();
/** The ledger the core's lanes keep: `{omps: [{pid}]}`. */
const Ledger = z.object({ omps: z.array(z.object({ pid: z.number() }).passthrough()) });

/** `modelRoles` of the config file, `undefined` when it cannot be read or parsed (a write still under way). */
export function readRoleValues(file: string): RoleValues | undefined {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "ENOENT" ? {} : undefined;
	}
	let parsed: unknown;
	try {
		parsed = parse(text);
	} catch {
		return undefined;
	}
	const config = ConfigRoles.safeParse(parsed ?? {});
	if (!config.success) return undefined;
	return Object.fromEntries(
		Object.entries(config.data.modelRoles ?? {}).flatMap(([role, value]) =>
			typeof value === "string" ? [[role, value]] : [],
		),
	);
}

/** Every role whose value differs, as `role: before → after` (`(none)` for a missing side), in role order. */
export function roleChanges(before: RoleValues, after: RoleValues): string[] {
	const roles = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
	return roles.flatMap(role =>
		before[role] === after[role] ? [] : [`${role}: ${before[role] ?? "(none)"} → ${after[role] ?? "(none)"}`],
	);
}

/** The pids `omp-pids.json` names (the omps this app runs); none when it cannot be read. */
export function ledgerPids(file: string): number[] {
	try {
		const ledger = Ledger.safeParse(JSON.parse(readFileSync(file, "utf8")));
		return ledger.success ? ledger.data.omps.map(omp => omp.pid) : [];
	} catch {
		return [];
	}
}

export interface ModelRolesWatchOptions {
	/** omp's config.yml. */
	configFile: string;
	/** The pids alive now, read when a change is logged. */
	pids: () => number[];
	log: (changes: string[], pids: number[]) => void;
}

/**
 * Watches the config file's folder (a save replaces the file, so a watch on the file itself would end with the first
 * rename) and logs each settled change of its roles. Returns the stop.
 */
export function watchModelRoles({ configFile, pids, log }: ModelRolesWatchOptions): () => void {
	let last = readRoleValues(configFile) ?? {};
	let timer: NodeJS.Timeout | undefined;
	const settle = () => {
		timer = undefined;
		const now = readRoleValues(configFile);
		if (now === undefined) return;
		const changes = roleChanges(last, now);
		last = now;
		if (changes.length > 0) log(changes, pids());
	};
	let watcher: FSWatcher;
	try {
		watcher = watch(dirname(configFile), { persistent: false }, (_event, name) => {
			if (name !== null && name.toString() !== basename(configFile)) return;
			clearTimeout(timer);
			timer = setTimeout(settle, SETTLE_MS);
		});
	} catch {
		// No agent folder yet (omp not set up): nothing to watch.
		return () => {};
	}
	watcher.on("error", () => watcher.close());
	return () => {
		clearTimeout(timer);
		watcher.close();
	};
}
