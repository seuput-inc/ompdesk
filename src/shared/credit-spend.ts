/**
 * Credit use (Settings › Models & accounts, one switch for every account, per machine): whether an account whose plan
 * is spent may go on serving from its ChatGPT credits or Claude extra usage. Off by default (the owner's rule, 12 Nov
 * 2026: no money leaves an account because OMPdesk kept working past the plan unless he turned that on).
 *
 * Main passes it to omp as `OMP_GUI_CREDIT_SPEND` at spawn and through the bridge's `credit_spend_set` on change and on
 * connect; the gui-bridge (resources/gui-bridge/credit-spend.ts) applies it. A paired host's tabs follow the host's
 * own pref. Dependency-free: main and the renderer import it.
 */

/** Boolean pref; never stored = off. */
export const CREDIT_SPEND_PREF = "creditSpend";

/** The switch of one computer, as `CREDIT_SPEND_GET|SET` and `host.creditSpend.*` answer. */
export interface CreditSpendState {
	enabled: boolean;
}

export function creditSpendEnabled(value: unknown): boolean {
	return value === true;
}

/**
 * How the gui-bridge words the request it refused because the plan is spent and the switch is off (`planSpentError`
 * in resources/gui-bridge/credit-spend-core.ts; `bridge-credit-spend.test.ts` holds the two together). The error card
 * reads it to say why the turn stopped.
 */
export const CREDIT_SPEND_OFF_WORDING = /Credit use setting is off/;
