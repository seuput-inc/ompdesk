import * as fs from "node:fs";

/**
 * Stock `omp config get|set <key> [value] --json`, for the one setting OMPdesk touches (`update.auto`). The global
 * config is the JSON file `OMP_GUI_TEST_STOCK_CONFIG` names (`{"update.auto": true}`); a missing file or key is
 * stock's default, off. `set` answers with the value it saved, as stock does.
 */
export function runConfig(): void {
	const [action, key, value] = process.argv.slice(3);
	const file = process.env.OMP_GUI_TEST_STOCK_CONFIG;
	if (key !== "update.auto" || !file || (action !== "get" && action !== "set")) {
		console.error(`fixture: unsupported config call: ${process.argv.slice(2).join(" ")}`);
		process.exit(1);
	}
	const saved: Record<string, unknown> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	if (action === "set") {
		saved[key] = value === "true";
		fs.writeFileSync(file, JSON.stringify(saved));
	}
	console.log(JSON.stringify({ key, value: saved[key] ?? false }));
}
