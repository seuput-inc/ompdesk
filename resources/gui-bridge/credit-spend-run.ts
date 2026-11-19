/**
 * The Credit use switch alone, for the omp runs OMPdesk starts without its bridge (`-e` this file): a scheduled run
 * and a PR draft, both `omp -p`. The switch is `OMP_GUI_CREDIT_SPEND`, as at a tab's spawn (src/main/omp-launch.ts
 * `creditSpendRun`); nothing changes it while the run lasts. credit-spend.ts installs the check before the run's
 * first request (`before_agent_start`).
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default async function creditSpendRun(pi: ExtensionAPI): Promise<void> {
	try {
		// Loaded here like the bridge's areas (index.ts): a stock export this omp lacks must not end the run at link time.
		(await import("./credit-spend")).install(pi);
	} catch (err) {
		pi.logger.error("ompdesk: credit use setting not applied to this run", { error: String(err) });
	}
}
