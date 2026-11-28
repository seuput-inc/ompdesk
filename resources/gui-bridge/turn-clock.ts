import { promptOrigin } from "./prompt-origin-core";

/** Sample the running omp's clock and zone at delivery, never while building the cacheable system prompt. */
export function turnClock(): string {
	const local = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "long" });
	const host = promptOrigin?.hostName;
	return `Session host clock${host ? ` (${JSON.stringify(host)})` : ""}: ${local.format(Date.now())} (${local.resolvedOptions().timeZone})`;
}
