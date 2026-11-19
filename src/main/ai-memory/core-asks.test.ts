/**
 * How main tells the core to start omp for a model call (`ompLaunchOf`): the Credit use switch goes with every such
 * omp (omp-launch.ts `creditSpendRun`), read at each launch, because none of them has a bridge to apply it.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { creditSpendRun } from "../omp-launch";
import { configureModelRuns, ompLaunchOf } from "./core-asks";

describe("ompLaunchOf", () => {
	it("starts omp as it did until main names the switch, then carries its extension and its state as it stands", async () => {
		const bare = await ompLaunchOf("/bin/omp");
		expect(bare.bin).toBe("/bin/omp");
		expect(bare.args).toBeUndefined();
		expect(bare.env.OTEL_SDK_DISABLED).toBe("true");

		let enabled = false;
		configureModelRuns(() => creditSpendRun("/bridge", enabled));
		const off = await ompLaunchOf("/bin/omp");
		expect(off.args).toEqual(["-e", join("/bridge", "credit-spend-run.ts")]);
		expect(off.env.OMP_GUI_CREDIT_SPEND).toBe("0");
		expect(off.env.PATH).toBe(bare.env.PATH);
		enabled = true;
		expect((await ompLaunchOf("/bin/omp")).env.OMP_GUI_CREDIT_SPEND).toBe("1");
	});
});
