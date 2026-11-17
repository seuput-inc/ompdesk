import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { HIDDEN_ROLES, ROLE_ORDER } from "../../resources/gui-bridge/model-role-contracts";
import { VISUALS_TEMPLATE_VARIABLES } from "../../resources/gui-bridge/modes/visuals-core";
import {
	FALLBACK_PROVIDER_IDS,
	PROVIDER_BRANDS,
} from "../../src/renderer/components/settings/providers/provider-marks";
import { KO_ROLE_NAMES } from "../../src/renderer/components/settings/schema-i18n";
import { KO_GROUP_TITLES, KO_SETTINGS } from "../../src/renderer/components/settings/schema-ko";
import { KO_SCHEMA_OPTION_TEXT } from "../../src/renderer/components/settings/schema-option-ko";
import type { DictionaryDiff } from "./dictionaries";

/**
 * Two fake omp package trees, laid out as Bun installs omp: an older one holding exactly what OMPdesk's dictionaries
 * list, and a newer one that adds an item to and drops one from each. The extraction reads them through
 * omp-package.ts as it reads a real omp, so its diff of the older is empty and of the newer names exactly the change.
 */

interface FakeSetting {
	id: string;
	ui: { label: string; description?: string; group?: string; options?: { value: string; label: string }[] };
}

interface FakeOmp {
	version: string;
	settings: FakeSetting[];
	roleIds: string[];
	roleNames: string[];
	providerIds: string[];
	visuals: string[];
}

const work = mkdtempSync(path.join(tmpdir(), "ompdesk-omp-bump-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function writeTree(name: string, omp: FakeOmp): string {
	const scope = path.join(work, name, "node_modules", "@oh-my-pi");
	const agent = path.join(scope, "pi-coding-agent");
	const catalog = path.join(scope, "pi-catalog");
	const files: Record<string, string> = {
		[path.join(agent, "package.json")]: JSON.stringify({
			name: "@oh-my-pi/pi-coding-agent",
			version: omp.version,
			exports: { "./*": { import: "./src/*.ts" } },
		}),
		[path.join(agent, "src", "config", "all-settings.ts")]:
			`export function orderedSettings() { return ${JSON.stringify(omp.settings)}; }`,
		[path.join(agent, "src", "config", "model-roles.ts")]: [
			`export const MODEL_ROLE_IDS = ${JSON.stringify(omp.roleIds)};`,
			`export const MODEL_ROLES = ${JSON.stringify(Object.fromEntries(omp.roleNames.map((name, i) => [`role${i}`, { name }])))};`,
		].join("\n"),
		[path.join(agent, "src", "prompts", "system", "system-prompt.md")]:
			`Intro\n{{#ifAny ${omp.visuals.join(" ")}}}\n- Visuals\n{{/ifAny}}\n`,
		[path.join(catalog, "package.json")]: JSON.stringify({
			name: "@oh-my-pi/pi-catalog",
			exports: { "./compat/*": { import: "./src/compat/*.ts" } },
		}),
		[path.join(catalog, "src", "compat", "auth.ts")]:
			`export function authProviders() { return ${JSON.stringify(omp.providerIds.map(id => ({ id })))}; }`,
		[path.join(catalog, "src", "compat", "providers.ts")]: "export function providerEntries() { return {}; }",
	};
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	}
	return agent;
}

function extract(root: string, ...args: string[]) {
	const run = spawnSync("bun", [fileURLToPath(new URL("./extract.ts", import.meta.url)), root, ...args], {
		encoding: "utf8",
		timeout: 60_000,
	});
	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/** The older omp: every key OMPdesk lists, each where stock keeps it. */
const settingIds = Object.keys(KO_SETTINGS);
const groups = Object.keys(KO_GROUP_TITLES);
const older: FakeOmp = {
	version: "1.0.0",
	settings: settingIds.map((id, i) => ({
		id,
		ui: {
			label: `Label of ${id}`,
			...(KO_SETTINGS[id]?.description ? { description: `About ${id}` } : {}),
			...(groups[i] ? { group: groups[i] } : {}),
			...(i === 0
				? { options: Object.keys(KO_SCHEMA_OPTION_TEXT).map(text => ({ value: text, label: text })) }
				: {}),
		},
	})),
	roleIds: [...new Set([...ROLE_ORDER, ...Object.keys(HIDDEN_ROLES)])],
	roleNames: Object.keys(KO_ROLE_NAMES),
	providerIds: [...Object.keys(PROVIDER_BRANDS), ...FALLBACK_PROVIDER_IDS],
	visuals: [...VISUALS_TEMPLATE_VARIABLES],
};

/** A described setting that holds no group and no options in the older tree. */
const droppedSetting = settingIds.findLast((id, i) => i >= groups.length && KO_SETTINGS[id]?.description) ?? "";
const droppedRole = ROLE_ORDER.at(-1) ?? "";
const droppedName = Object.keys(KO_ROLE_NAMES)[0] ?? "";
const droppedProvider = Object.keys(PROVIDER_BRANDS)[0] ?? "";
const droppedVisual = VISUALS_TEMPLATE_VARIABLES.at(-1) ?? "";

const newer: FakeOmp = {
	version: "1.1.0",
	settings: [
		...older.settings.filter(setting => setting.id !== droppedSetting),
		{
			id: "fakeNew.setting",
			ui: {
				label: "Fake new setting",
				description: "What the fake new setting does",
				group: "Fake new group",
				options: [{ value: "fake", label: "Fake new option" }],
			},
		},
	],
	roleIds: [...older.roleIds.filter(id => id !== droppedRole), "fakerole"],
	roleNames: [...older.roleNames.filter(name => name !== droppedName), "Fake role"],
	providerIds: [...older.providerIds.filter(id => id !== droppedProvider), "fake-provider"],
	visuals: [...older.visuals.filter(name => name !== droppedVisual), "renderFake"],
};

const olderRoot = writeTree("older", older);
const newerRoot = writeTree("newer", newer);

describe("omp-bump extraction", () => {
	it("finds nothing to add or drop when the omp holds exactly what OMPdesk's dictionaries list", () => {
		const run = extract(olderRoot);
		expect(run.stderr).toBe("");
		const diff = JSON.parse(run.stdout) as { omp: string; dictionaries: DictionaryDiff[] };
		expect(diff.omp).toBe("1.0.0");
		expect(diff.dictionaries.filter(d => d.missing.length > 0 || d.stale.length > 0)).toEqual([]);
	}, 60_000);

	it("names exactly what a newer omp added and dropped, per dictionary", () => {
		expect([droppedSetting, droppedRole, droppedName, droppedProvider, droppedVisual]).not.toContain("");
		const run = extract(newerRoot);
		const diff = JSON.parse(run.stdout) as { omp: string; dictionaries: DictionaryDiff[] };
		expect(diff.omp).toBe("1.1.0");
		expect(
			Object.fromEntries(
				diff.dictionaries.map(d => [d.id, { missing: d.missing.map(need => need.key), stale: d.stale }]),
			),
		).toEqual({
			"settings.label": { missing: ["fakeNew.setting"], stale: [droppedSetting] },
			"settings.description": { missing: ["fakeNew.setting"], stale: [droppedSetting] },
			"settings.group": { missing: ["Fake new group"], stale: [] },
			"settings.option": { missing: ["Fake new option"], stale: [] },
			"roles.name": { missing: ["Fake role"], stale: [droppedName] },
			"roles.use": { missing: ["fakerole"], stale: [droppedRole] },
			"roles.fallback": { missing: ["fakerole"], stale: [droppedRole] },
			"roles.place": { missing: ["fakerole"], stale: [droppedRole] },
			"providers.mark": { missing: ["fake-provider"], stale: [droppedProvider] },
			"visuals.variables": { missing: ["renderFake"], stale: [droppedVisual] },
		});
		expect(diff.dictionaries.find(d => d.id === "settings.label")?.missing).toEqual([
			{ key: "fakeNew.setting", text: "Fake new setting" },
		]);
	}, 60_000);

	it("--check fails listing every missing required string by dictionary and key, and passes the older omp", () => {
		const failing = extract(newerRoot, "--check");
		expect(failing.status).toBe(1);
		expect(failing.stdout).toBe("");
		expect(failing.stderr.trim().split("\n")).toEqual([
			"omp 1.1.0 has 6 strings OMPdesk's dictionaries lack:",
			'  settings.label (src/renderer/components/settings/schema-ko.ts): fakeNew.setting "Fake new setting"',
			'  settings.description (src/renderer/components/settings/schema-ko.ts): fakeNew.setting "What the fake new setting does"',
			"  settings.group (src/renderer/components/settings/schema-ko.ts): Fake new group",
			"  settings.option (src/renderer/components/settings/schema-option-ko.ts): Fake new option",
			"  roles.name (src/renderer/components/settings/schema-i18n.ts): Fake role",
			"  providers.mark (src/renderer/components/settings/providers/provider-marks.ts): fake-provider",
		]);
		const passing = extract(olderRoot, "--check");
		expect(passing.status).toBe(0);
		expect(passing.stdout.trim()).toBe("omp 1.0.0: every required dictionary covers it");
	}, 60_000);
});
