/**
 * A fresh scheduled run's answer as a quiet note in the session its schedule names (`ScheduleDraft.resultsTo`; a bot's
 * own automation answers in its home chat): main writes it, and a bot's chat draws it as a run result card (Orca's
 * `bot-automation-result-note.ts`). The note always reads in English: the agent reads it too.
 *
 * Dependency-free.
 */

const HEAD = 'The scheduled run "';
const TAIL = '" finished. Its answer:\n\n';

export function scheduleResultNote(name: string, answer: string): string {
	return `${HEAD}${name}${TAIL}${answer}`;
}

/** The run's name and answer, or null for any other note. */
export function parseScheduleResultNote(text: string): { name: string; answer: string } | null {
	if (!text.startsWith(HEAD)) return null;
	const end = text.indexOf(TAIL, HEAD.length);
	if (end < 0) return null;
	return { name: text.slice(HEAD.length, end), answer: text.slice(end + TAIL.length) };
}
