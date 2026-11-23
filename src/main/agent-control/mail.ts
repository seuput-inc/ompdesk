export const MAIL_KINDS = ["progress", "done", "blocked", "question", "review", "note"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export interface MailDelivery {
	triggerTurn: boolean;
	deliverAs?: "aside";
}
