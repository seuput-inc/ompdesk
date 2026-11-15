/**
 * Sessions tell each other things (the mailbox): an opened session reports to the session that opened it
 * (`ompdesk_report`), and siblings of one opener can write to each other, instead of the opener polling. The rules
 * (the wrapper a report arrives in, dispatch ids, coalescing, the outbox) live in the Rust core
 * (`native/ompdesk/crates/core/src/agentctl/rules/mail.rs`, `journal/mail_outbox.rs`); what stays here is the kinds the
 * tool schema lists and how stock delivers each, which the bridge tests and main's host seam read.
 *
 *   question, blocked,  `triggerTurn: true`: an idle receiver starts a turn on it. A question or blocker is
 *   done, review        answered with `ompdesk_session_send` or by the user; nothing answers it on its own.
 *   progress, note      `triggerTurn: false`: the report does not start a turn.
 */

export const MAIL_KINDS = ["progress", "done", "blocked", "question", "review", "note"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface MailDelivery {
	triggerTurn: boolean;
}

/** Whether a report of this kind starts a turn. */
export function deliveryFor(kind: MailKind): MailDelivery {
	switch (kind) {
		case "question":
		case "blocked":
		case "done":
		case "review":
			return { triggerTurn: true };
		default:
			return { triggerTurn: false };
	}
}
