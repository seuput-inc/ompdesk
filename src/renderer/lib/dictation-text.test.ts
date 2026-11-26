import { describe, expect, it } from "vitest";
import { createDictationDictionary, parseDictationTerms, removeFillerWords, tidyDictation } from "./dictation-text";

describe("filler words", () => {
	it("drops thinking sounds with their pause, never words with meaning", () => {
		expect(removeFillerWords("we should, uh, ship it", "en")).toBe("we should ship it");
		expect(removeFillerWords("Um, let's go. Like, so well", "en")).toBe("Let's go. Like, so well");
		expect(removeFillerWords("we should, um.", "en")).toBe("we should.");
		expect(removeFillerWords("hm? what", "en")).toBe("hm? what");
		expect(removeFillerWords("open um.txt", "en")).toBe("open um.txt");
	});

	it("keeps an all-caps word in mixed text, and drops the language's own sounds", () => {
		expect(removeFillerWords("ask UM about it", "en")).toBe("ask UM about it");
		expect(removeFillerWords("음 이거 고쳐 줘", "ko")).toBe("이거 고쳐 줘");
		expect(removeFillerWords("그 파일 열어 줘", "ko")).toBe("그 파일 열어 줘");
		// No language: only English sounds that are no word elsewhere, and none in non-Latin text.
		expect(removeFillerWords("uhm right", undefined)).toBe("right");
		expect(removeFillerWords("음 이거", undefined)).toBe("음 이거");
	});
});

describe("the glossary", () => {
	it("reads one term per line, or heard = Term, dropping blanks and repeats", () => {
		expect(parseDictationTerms("pnpm\n\n super base = Supabase \npnpm")).toEqual([
			{ term: "pnpm" },
			{ term: "Supabase", heardAs: "super base" },
		]);
		expect(parseDictationTerms(undefined)).toEqual([]);
	});

	it("spells a term's way however the model split or cased it, and what it heard instead", () => {
		const spell = createDictationDictionary(
			parseDictationTerms("pnpm\nuseAudioCapture\nsuper base = Supabase\n.NET"),
		);
		expect(spell?.("Run PNPM install")).toBe("Run pnpm install");
		expect(spell?.("call use audio capture now")).toBe("call useAudioCapture now");
		expect(spell?.("deploy to super base")).toBe("deploy to Supabase");
		expect(spell?.("a .net app")).toBe("a .NET app");
		expect(createDictationDictionary([])).toBeNull();
	});

	it("drops filler words before spelling, so a lowercase term is never recapitalized", () => {
		expect(tidyDictation("Um, pnpm install", "en", [{ term: "pnpm" }])).toBe("pnpm install");
	});
});
