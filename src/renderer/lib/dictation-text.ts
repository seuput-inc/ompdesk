/**
 * What dictated words go through before they land: the filler sounds of the language heard are dropped, then the
 * person's terms (Settings › Dictation, prefs `dictationTerms`) are spelled their way, then, only when the person
 * turned it on (`dictationCleanup`, off by default), a small model tidies punctuation and spoken corrections.
 *
 * Adapted from Orca (https://github.com/stablyai/orca, commit 02cecc98, MIT): `removeFillerWords` from
 * `src/shared/speech/dictation/dictation-filler-words.ts`, the term spelling from `dictation-term-spelling.ts` and
 * `dictation-dictionary.ts`, the order from `dictation-text-pipeline.ts:45-50`. Orca's near-miss pass (a single word
 * close to a long term, against an English word list) is not carried: a term the model mishears is written down as
 * "heard = Term" instead.
 */

// Sounds people make while thinking, per language. Never words with meaning ("like", "so", "well", "那个", "그").
const FILLERS_BY_LANGUAGE: Record<string, string> = {
	en: "u+m+|u+h+m*|er|e+r+m+|h+m+|m{3,}",
	de: "ä+h+m*|ö+h+m*|e+h+m+|h+m+|m{3,}",
	es: "e+h{2,}|e+h+m+|e+m+|h+m+|m{3,}",
	fr: "e+u+h+|h+e+u+|h+u+m+|h+m+|m{3,}",
	it: "e+h{2,}|e+h+m+|u+h+m+|h+m+|m{3,}",
	pt: "h+ã+|ã+h+|h+u+m+|h+m+|m{3,}",
	nl: "e+h+m*|u+h+m*|h+m+|m{3,}",
	ru: "э+м*|х+м+|м{3,}",
	ja: "え[ーえっ]*と|えー+|あのー+|うー+ん|んー+",
	ko: "으*음+|흠+",
	// 嗯 alone is also "yes", so only the one a pause follows goes.
	zh: "嗯+(?=\\s*[，,、])|呃+|[额額]+",
};

// For an unknown language: English fillers that are no word elsewhere ("um" is German and Portuguese, "er" German).
const LANGUAGE_NEUTRAL_FILLERS = "u+h+m*|u+m{2,}|e+r+m+|h+m+|m{3,}";

const WORD_CHAR = String.raw`[\p{L}\p{N}\p{M}_/'\u2019\-]`;
// A filler stands alone: nothing joins it to a word (a dot only does inside a name like "um.txt"),
// and "hm?" or "eh!" is a question or a call, so it stays.
const standalone = (fillers: string): string =>
	String.raw`(?<!${WORD_CHAR}|${WORD_CHAR}\.)(${fillers})(?!${WORD_CHAR}|\.${WORD_CHAR})(?!\s*[?\uFF1F!\uFF01])`;
// The comma or ellipsis after a filler goes with it.
const TRAILING_PAUSE = String.raw`(?:\s*(?<pause>[,\uFF0C\u3001\u2026]|\.{3}))?\s*`;
const SENTENCE_END_CHARS = ".!?。！？";
const SENTENCE_END_RE = new RegExp(`^[${SENTENCE_END_CHARS}]+\\s*`, "u");
// A comma left in front of a removed filler that ended the sentence or the text.
const TRAILING_SOFT_PUNCTUATION_RE = /[\s,\uFF0C\u3001]+$/u;
// The comma before a filler that a pause also follows, keeping the space after it.
const COMMA_BEFORE_PAUSED_FILLER_RE = /[,\uFF0C\u3001](\s*)$/u;
const NON_LATIN_LETTER_RE = /(?=\p{L})\P{Script=Latin}/u;

function fillerPattern(language: string | undefined, text: string): RegExp | null {
	const list = language ? FILLERS_BY_LANGUAGE[language === "yue" ? "zh" : language] : undefined;
	if (list) return new RegExp(standalone(list) + TRAILING_PAUSE, "giu");
	if (NON_LATIN_LETTER_RE.test(text)) return null;
	return new RegExp(standalone(LANGUAGE_NEUTRAL_FILLERS) + TRAILING_PAUSE, "giu");
}

// In mixed-case text an all-caps "UM" or "HMM" is more likely a name or acronym than a sound.
function isAllCaps(word: string): boolean {
	return word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase();
}

function capitalizeLowercaseWord(text: string): string {
	const word = /^\p{L}+/u.exec(text)?.[0];
	if (!word || word !== word.toLowerCase()) return text;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Drops standalone filler sounds of `language` (a code) and the pause punctuation after them; text with none comes back unchanged. */
export function removeFillerWords(text: string, language: string | undefined): string {
	const pattern = fillerPattern(language, text);
	if (!pattern) return text;
	let out = "";
	let cursor = 0;
	let capitalizeNext = false;
	// Some models write everything in capitals, where "UM" is still a sound.
	const caseless = text === text.toUpperCase();
	const keep = (segment: string): void => {
		if (!segment) return;
		out += capitalizeNext ? capitalizeLowercaseWord(segment) : segment;
		capitalizeNext = false;
	};
	for (const match of text.matchAll(pattern)) {
		const filler = match[1] ?? "";
		if (!caseless && isAllCaps(filler)) continue;
		keep(text.slice(cursor, match.index));
		cursor = match.index + match[0].length;
		const before = out.trimEnd();
		const atSentenceStart = before === "" || SENTENCE_END_CHARS.includes(before.slice(-1));
		const sentenceEnd = SENTENCE_END_RE.exec(text.slice(cursor));
		// "we should, um." keeps its full stop; "Um." on its own goes entirely.
		if (sentenceEnd && atSentenceStart) cursor += sentenceEnd[0].length;
		else if (sentenceEnd) out = out.replace(TRAILING_SOFT_PUNCTUATION_RE, "");
		// "we should, uh, ship" set the filler off on both sides; neither comma belongs to the sentence.
		else if (match.groups?.pause) out = out.replace(COMMA_BEFORE_PAUSED_FILLER_RE, "$1");
		// Only a capitalised "Um" began a sentence the next word now begins.
		capitalizeNext ||= atSentenceStart && filler.charAt(0) !== filler.charAt(0).toLowerCase();
	}
	if (cursor === 0) return text;
	// A filler at the very end leaves the comma before it dangling.
	if (cursor === text.length) out = out.replace(TRAILING_SOFT_PUNCTUATION_RE, "");
	else keep(text.slice(cursor));
	return out.trim();
}

/** A word or phrase dictation spells `term`'s way, also replacing `heardAs` (what the model writes instead). */
export interface DictationTerm {
	term: string;
	heardAs?: string;
}

export const MAX_DICTATION_TERMS = 500;
const MAX_TERM_LENGTH = 100;

/**
 * The glossary as the person writes it: one term per line, or "heard = Term" where the model writes `heard`. Blank
 * lines go; the same entry twice is one.
 */
export function parseDictationTerms(raw: unknown): DictationTerm[] {
	if (typeof raw !== "string") return [];
	const terms: DictationTerm[] = [];
	const seen = new Set<string>();
	for (const line of raw.split("\n")) {
		const split = line.lastIndexOf("=");
		const term = (split >= 0 ? line.slice(split + 1) : line).trim().slice(0, MAX_TERM_LENGTH);
		const heardAs = split >= 0 ? line.slice(0, split).trim().slice(0, MAX_TERM_LENGTH) : "";
		const id = `${term}\u0000${heardAs}`;
		if (!term || seen.has(id)) continue;
		seen.add(id);
		terms.push(heardAs ? { term, heardAs } : { term });
	}
	return terms.slice(0, MAX_DICTATION_TERMS);
}

// Symbols that belong to a name ("C#", "C++", "@orca") count as part of a word, so a term never doubles them.
const WORD_RE = /[\p{L}\p{M}\p{N}#+@$&]+/gu;
// Spaces, or one joiner as in "on-change" or "stt-worker.ts": what may sit between the words of one term.
const JOINING_GAP_RE = /^(?:\s+|[-_./])$/u;
// A term's own leading or trailing joiners, as in ".NET", taken along when the text already has them.
const EDGE_JOINERS_RE = /^([-_./]*)[\s\S]*?([-_./]*)$/u;
// Scripts written without spaces, where a phrase can only be found inside a longer run of letters.
const UNSPACED_SCRIPT_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const MAX_WORDS_PER_TERM = 8;

// "Use Audio Capture", "use-audio-capture" and "useAudioCapture" all key as "useaudiocapture".
function wordKey(text: string): string {
	return (text.normalize("NFKC").toLowerCase().match(WORD_RE) ?? []).join("");
}

interface Spelling {
	term: string;
	lead: string;
	trail: string;
}

function spelling(term: string): Spelling {
	const [, lead = "", trail = ""] = EDGE_JOINERS_RE.exec(term) ?? [];
	return { term, lead, trail };
}

/** Rewrites runs of words that key the same as a term (or its "heard as") to the term's spelling; null without terms. */
export function createDictationDictionary(terms: readonly DictationTerm[]): ((text: string) => string) | null {
	const byKey = new Map<string, Spelling>();
	const unspacedAliases: [heardAs: string, term: string][] = [];
	const add = (key: string, term: string): void => {
		if (key && !byKey.has(key)) byKey.set(key, spelling(term));
	};
	// A "heard as" is what the person asked for, so it beats another term spelled the same.
	for (const { term, heardAs } of terms) {
		if (heardAs && UNSPACED_SCRIPT_RE.test(heardAs)) unspacedAliases.push([heardAs, term]);
		else if (heardAs) add(wordKey(heardAs), term);
	}
	for (const { term } of terms) add(wordKey(term), term);
	if (byKey.size === 0 && unspacedAliases.length === 0) return null;
	const longestKey = Math.max(0, ...[...byKey.keys()].map(key => key.length));
	return text => {
		let out = text;
		for (const [alias, term] of unspacedAliases) out = out.split(alias).join(term);
		return byKey.size > 0 ? replaceWordRuns(out, byKey, longestKey) : out;
	};
}

// At each word, the longest run of joined words whose key is a term's becomes that term.
function replaceWordRuns(text: string, byKey: Map<string, Spelling>, longestKey: number): string {
	const words = [...text.matchAll(WORD_RE)].map(word => ({
		from: word.index,
		to: word.index + word[0].length,
		key: wordKey(word[0]),
	}));
	// joinsNext[i]: words i and i + 1 may belong to one term.
	const joinsNext = words.map(
		(word, i) => i + 1 < words.length && JOINING_GAP_RE.test(text.slice(word.to, words[i + 1]?.from)),
	);
	let out = "";
	let cursor = 0;
	for (let start = 0; start < words.length; ) {
		let key = "";
		let match: { end: number; spelling: Spelling } | null = null;
		for (let end = start; end < words.length && end - start < MAX_WORDS_PER_TERM; end++) {
			if (end > start && !joinsNext[end - 1]) break;
			key += words[end]?.key ?? "";
			if (key.length > longestKey) break;
			const found = byKey.get(key);
			if (found) match = { end, spelling: found };
		}
		if (!match) {
			start++;
			continue;
		}
		const { term, lead, trail } = match.spelling;
		let from = words[start]?.from ?? 0;
		let to = words[match.end]?.to ?? from;
		if (lead && from - lead.length >= cursor && text.slice(from - lead.length, from) === lead) from -= lead.length;
		if (trail && text.startsWith(trail, to)) to += trail.length;
		out += text.slice(cursor, from) + term;
		cursor = to;
		start = match.end + 1;
	}
	return out + text.slice(cursor);
}

/** Filler words first, then the terms: a filler removed at a sentence start cannot recapitalize "pnpm". */
export function tidyDictation(text: string, language: string | undefined, terms: readonly DictationTerm[]): string {
	const withoutFillers = removeFillerWords(text, language);
	return createDictationDictionary(terms)?.(withoutFillers) ?? withoutFillers;
}

async function readPref(key: string): Promise<unknown> {
	try {
		return await window.omp.prefs?.get(key);
	} catch {
		return undefined;
	}
}

/**
 * A take's words as they land: tidied, then, when the person turned model cleanup on, cleaned by the bridge's small
 * model (`dictation_cleanup`); a cleanup that fails, is not offered or is skipped (`skip` aborts: Esc on the bar)
 * leaves the words as tidied (Orca's ✕ on its cleanup pill, `use-dictation-cleanup.ts:39-75`).
 */
export async function polishDictation(text: string, language: string | undefined, skip?: AbortSignal): Promise<string> {
	if (!text.trim()) return text;
	const [rawTerms, cleanup] = await Promise.all([readPref("dictationTerms"), readPref("dictationCleanup")]);
	const terms = parseDictationTerms(rawTerms);
	const tidied = tidyDictation(text, language, terms);
	if (cleanup !== true || skip?.aborted) return tidied;
	const skipped = Promise.withResolvers<string>();
	skip?.addEventListener("abort", () => skipped.resolve(tidied), { once: true });
	const cleaned = window.omp.rpc
		.dictationCleanup(
			tidied,
			terms.map(entry => entry.term),
		)
		.then(response => {
			const answer = response.success ? (response.data as { text?: unknown } | undefined)?.text : undefined;
			return typeof answer === "string" && answer.trim() ? answer.trim() : tidied;
		})
		.catch(() => tidied);
	return Promise.race([cleaned, skipped.promise]);
}
