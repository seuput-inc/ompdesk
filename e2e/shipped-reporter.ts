import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/** Preserve the failing view with its item, without publishing a profile, trace or raw error. */
export default class ShippedReporter implements Reporter {
	readonly #cases: { title: string; status: TestResult["status"] }[] = [];

	onTestEnd(test: TestCase, result: TestResult): void {
		this.#cases.push({ title: test.title, status: result.status });
		if (result.status === "passed") return;
		const stem = test.title.replace(/[^a-z0-9-]+/gi, "-");
		for (const [i, attachment] of result.attachments.entries()) {
			if (attachment.contentType === "image/png" && attachment.path) {
				copyFileSync(attachment.path, join(process.env.OMP_GUI_SHIPPED_CAPTURES!, `failure-${stem}-${i}.png`));
			}
		}
	}

	onEnd(): void {
		writeFileSync(join(process.env.OMP_GUI_SHIPPED_CAPTURES!, "cases.json"), JSON.stringify(this.#cases, null, 2));
	}
}
