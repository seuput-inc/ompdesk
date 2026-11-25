/**
 * The extension of the omp runs OMPdesk starts without its bridge (`-e` this file): a scheduled run and a PR draft,
 * both `omp -p`.
 * - The Credit use switch: `OMP_GUI_CREDIT_SPEND`, as at a tab's spawn (src/main/omp-launch.ts `creditSpendRun`);
 *   nothing changes it while the run lasts. credit-spend.ts installs the check before the run's first request
 *   (`before_agent_start`).
 * - A scheduled run's usage: with `OMP_GUI_RUN_USAGE` set (src/main/schedules.ts `ompRunLauncher`), the run's end
 *   writes stock's own tally (`SessionManager.getUsageStatistics`, subagents and judge calls included) to that file.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { RUN_USAGE_ENV } from "./credit-spend-core";

export default async function creditSpendRun(pi: ExtensionAPI): Promise<void> {
	const usageFile = process.env[RUN_USAGE_ENV];
	if (usageFile)
		pi.on("agent_end", (event, ctx) => {
			if (event.willContinue) return;
			try {
				writeFileSync(usageFile, JSON.stringify(ctx.sessionManager.getUsageStatistics()));
			} catch (err) {
				pi.logger.error("ompdesk: run usage not recorded", { error: String(err) });
			}
		});
	try {
		// Loaded here like the bridge's areas (index.ts): a stock export this omp lacks must not end the run at link time.
		(await import("./credit-spend")).install(pi);
	} catch (err) {
		pi.logger.error("ompdesk: credit use setting not applied to this run", { error: String(err) });
	}
}
