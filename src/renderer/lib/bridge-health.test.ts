import { describe, expect, it } from "vitest";
import { bridgeHealthToast } from "./bridge-health";
import { translate } from "./i18n";

describe("bridgeHealthToast", () => {
	it("names the unavailable features in the UI language and stays until dismissed", () => {
		const input = bridgeHealthToast(
			{
				kind: "unsupported",
				ompVersion: "19.0.0",
				features: ["relaunchResume", "mcp", "futureFeature"],
				repairing: true,
			},
			translate,
		);
		expect(input.variant).toBe("warning");
		expect(input.durationMs).toBe(Number.POSITIVE_INFINITY);
		expect(input.title).toBe(translate("bridgeHealth.unsupportedTitle"));
		// Unknown ids (a newer bridge than these locales) fall back to the raw id.
		expect(input.message).toBe(
			"omp 19.0.0 lacks internals OMPdesk needs for: Continuing interrupted work after a relaunch, MCP servers, futureFeature. OMPdesk looks for a newer omp and repairs the install itself. If this stays, report an issue.",
		);
	});

	it("names only the one missing action, and promises no repair when nothing core is missing", () => {
		const input = bridgeHealthToast(
			{ kind: "unsupported", ompVersion: "19.0.0", features: ["abortCompaction"], repairing: false },
			translate,
		);
		expect(input.message).toBe(
			"omp 19.0.0 lacks internals OMPdesk needs for: Cancel compaction. Only these are off; everything else works. OMPdesk keeps omp updated, and a later omp may bring them back. If this stays, report an issue.",
		);
	});

	it("explains a bridge that never connected", () => {
		const input = bridgeHealthToast(
			{ kind: "unavailable", ompVersion: "19.0.0", reason: "GUI bridge did not accept a connection within 3000ms" },
			translate,
		);
		expect(input.title).toBe("OMPdesk features unavailable");
		expect(input.message).toContain("(omp 19.0.0): GUI bridge did not accept a connection within 3000ms.");
		expect(input.message).toContain("repairs the install itself");
	});
});
