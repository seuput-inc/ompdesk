import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/shipped-capture-report.mjs <download-directory>");
mkdirSync(root, { recursive: true });
const rows = [
	"# Shipped Windows comparison",
	"",
	"A PNG is a captured view, not a passing assertion. See the case results below.",
	"",
];
const problems = [];
const stages = [
	["before", "v0.152.0"],
	["after", "v0.153.0"],
].map(([prefix, tag]) => {
	const dir = `shipped-${tag}`;
	const folder = join(root, dir);
	const files = existsSync(folder) ? readdirSync(folder) : [];
	const json = name => (files.includes(name) ? JSON.parse(readFileSync(join(folder, name), "utf8")) : undefined);
	const build = json("build.json");
	if (build?.tag !== tag || !build.app || !build.driver) problems.push(`Missing ${tag} build identity`);
	rows.push(`- ${tag}: app ${build?.app ?? "missing"}; driver ${build?.driver ?? "missing"}`);
	return { prefix, tag, dir, files, json, build, cases: json("cases.json") ?? [] };
});
if (stages[0].build?.driver !== stages[1].build?.driver) problems.push("Driver commits differ");
rows.push("", "| Item and criterion | v0.152.0 | v0.153.0 |", "| --- | --- | --- |");
for (const [id, criterion, beforeShots, afterShots] of [
	[51, "Labels, form height, host compatibility, template, handover and import", 20, 29],
	[52, "First task and progress before scroll, two workers and three phone lines", 5, 5],
	[53, "Question counts, independent work, edit, withdrawal, review and send", 10, 20],
	[43, "Provider icons, Korean names, keyboard focus and filtered models", 4, 4],
	[44, "Two-line rows, measured gap and reading sizes, stored preference", 6, 6],
	[50, "Credit on owning account only, aligned window bars", 4, 4],
]) {
	const cells = stages.map(({ prefix, tag, dir, files, cases }) => {
		const names = files.filter(name => name.startsWith(`${prefix}-${id}-`) && name.endsWith(".png"));
		const runs = cases.filter(c => c.title.startsWith(`shipped captures #${id} `));
		const required = prefix === "before" ? beforeShots : afterShots;
		if (!runs.length || runs.some(c => c.status !== "passed") || names.length < required)
			problems.push(`#${id}: inspect ${tag} (${names.length}/${required} requested images)`);
		return (
			[
				...runs.map(c => `${c.status}: ${c.title.replace(`shipped captures #${id} `, "")}`),
				...names.map(name => `[${name.slice(prefix.length + 4, -4)}](${dir}/${name})`),
			].join("<br>") || "Missing"
		);
	});
	rows.push(`| #${id} ${criterion} | ${cells.join(" | ")} |`);
}
rows.push(
	"",
	"## #51 Empty form (CSS px)",
	"",
	"| Locale / surface | Form before → after | Dialog before → after |",
	"| --- | --- | --- |",
);
for (const lang of ["ko", "en"])
	for (const surface of ["desktop", "phone390"]) {
		const sizes = stages.map(s => s.json(`${s.prefix}-51-${lang}-${surface}-new-bot-empty.json`));
		const pair = key => sizes.map(s => s?.[key] ?? "missing").join(" → ");
		if (!(sizes[1]?.formHeightCssPx < sizes[0]?.formHeightCssPx))
			problems.push(`#51 ${lang}/${surface}: no verified reduction in form height`);
		rows.push(`| ${lang} / ${surface} | ${pair("formHeightCssPx")} | ${pair("dialogHeightCssPx")} |`);
	}
rows.push(
	"",
	"## #44 Bot rows (CSS px)",
	"",
	"Orca reference, default desktop: 48 px row, 0 px inter-row gap, 8 px icon-to-text; 13 px title and prose, 12 px code.",
	"",
	"| Tag / surface | Height (each row) | Inter-row gap | Avatar → text | Title / detail font | Body / prose / code |",
	"| --- | --- | --- | --- | --- | --- |",
);
for (const s of stages)
	for (const surface of ["desktop-default", "390-default", "desktop-saved-18"]) {
		const size = s.json(`${s.prefix}-44-ko-${surface}.json`);
		if (!size?.rows?.length) {
			problems.push(`#44 ${s.tag}/${surface}: no measured rows`);
			continue;
		}
		const row = size.rows[0];
		rows.push(
			`| ${s.tag} / ${surface} | ${size.rows.map(r => r.height).join(", ")} | ${size.gap} | ${row.avatarToText} | ${row.titleFont} / ${row.secondaryFont} | ${size.text.body} / ${size.text.prose} / ${size.text.code} |`,
		);
	}
for (const s of stages)
	for (const name of s.files.filter(file => file.startsWith("failure-") && file.endsWith(".png")))
		rows.push(`- [${s.tag} failure: ${name}](${s.dir}/${name})`);
rows.push(
	"",
	"## Missing evidence or failing conditions",
	"",
	...(problems.length
		? problems.map(p => `- ${p}`)
		: ["No automated condition failed. Inspect the images for visual defects."]),
	"",
);
writeFileSync(join(root, "comparison.md"), rows.join("\n"));
if (problems.length) process.exitCode = 1;
