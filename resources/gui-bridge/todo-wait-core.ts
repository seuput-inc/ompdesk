/** The part of a stock todo phase used by the completion check. */
export interface PhaseLike {
	tasks: ReadonlyArray<{ content: string; status: string }>;
}

const WAITING_LEAD =
	/^[\s([{"'`*_>-]*(?:(?:waiting|wait|awaiting|await|blocked (?:on|by)|on hold)\b|대기(?![가-힣])|기다리)/i;
const WAITING_TAIL = /(?:대기|기다리기|기다림)(?:\s*중)?[\s).\]}"'`*_]*$/;

/** An item text the session wrote as waiting on something: "Wait for the reply of …", "대기: …", "… 응답 대기". */
export function isWaitingItem(content: string): boolean {
	const text = content.trim();
	return WAITING_LEAD.test(text) || WAITING_TAIL.test(text);
}

/** True when the list has open items and every one of them is written as waiting. */
export function onlyWaitingItems(phases: readonly PhaseLike[]): boolean {
	const open = phases
		.flatMap(phase => phase.tasks)
		.filter(task => task.status === "pending" || task.status === "in_progress");
	return open.length > 0 && open.every(task => isWaitingItem(task.content));
}
