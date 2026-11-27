import type { UiLanguage } from "./ui-language";

/** What's new shows the opening paragraph, or the first item if the release opens with a list. */
export function changelogSummary(notes: string): string {
	const block = notes.split(/\n\s*\n/).find(part => part.trim() !== "" && !part.trimStart().startsWith("#")) ?? "";
	const lines = block
		.split("\n")
		.map(line => line.trim())
		.filter(Boolean);
	const list = /^[-*]\s+/.test(lines[0] ?? "");
	return (list ? lines.slice(0, 1) : lines)
		.join(" ")
		.replace(/^[-*]\s+/, "")
		.replace(/\*\*|`/g, "")
		.trim();
}

export function releaseSentence(notes: string, lang: UiLanguage): string {
	const text = changelogSummary(notes);
	if (!text) return "";
	return new Intl.Segmenter(lang, { granularity: "sentence" }).segment(text).containing(0)?.segment.trim() ?? "";
}

/** release.yml publishes the Korean and English sections separated by a rule, then appends the omp requirement. */
export function publishedReleaseSummary(notes: string): Record<UiLanguage, string> {
	const [ko = "", en = ""] = notes.replace(/^---\s*\nRequires omp \*\*[^\n]+$/m, "").split(/^---[ \t]*\r?$/m, 2);
	return { ko: releaseSentence(ko, "ko"), en: releaseSentence(en, "en") };
}
