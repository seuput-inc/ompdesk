/**
 * `src/renderer/lib/emoji.ts` copies stock pi-tui `prompt/emoji-autocomplete` and its `prompt/data/emojis.json`,
 * because completion runs on every keystroke in the renderer, where omp is not loaded. The installed omp's
 * functions answer the same text here, and the shortcode table is stock's file byte for byte.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { expandEmoticons, getEmojiSuggestions, tryEmojiInlineReplace } from "../renderer/lib/emoji";
import { runStock, stockSource } from "./test-bridge-probe";

const autocomplete = stockSource("pi-tui", path.join("prompt", "emoji-autocomplete.ts"));
const table = stockSource("pi-tui", path.join("prompt", "data", "emojis.json"));

/** Text before the cursor: shortcodes, every emoticon on a terminator, boundaries, and prose that must stay. */
const TYPED = [
	":j",
	":joy",
	"hi :sm",
	"(:thu",
	"note:",
	"a:joy",
	":D",
	":-",
	":p",
	":zzzzz",
	":joy:",
	"see :thumbsup:",
	":JOY:",
	"x:joy:",
	"::",
	":nosuchname:",
	":) ",
	":-) ",
	";) ",
	"<3 ",
	"</3\t",
	"B) ",
	"8) ",
	"B-) ",
	"o.O\n",
	"xD ",
	"XD\r",
	":'( ",
	">:( ",
	"http:) ",
	"item 8) ",
	"(B) ",
	":3 ",
];

const MESSAGES = [
	"thanks :)",
	":-) ok :D",
	"step 8) and (B) stay",
	"a:)b <3",
	"done ;)\nnext :P",
	"url http://x:/ y",
	"o.O XD xD B-)",
	":",
];

describe.skipIf(!autocomplete || !table)("emoji completion against the installed stock pi-tui", () => {
	it("ships stock's shortcode table byte for byte", () => {
		const ours = readFileSync(path.join(__dirname, "..", "renderer", "lib", "data", "emojis.json"));
		expect(ours.equals(readFileSync(table ?? ""))).toBe(true);
	});

	it("suggests, replaces inline and expands on submit exactly as stock does", async () => {
		const stock = runStock<{ suggest: unknown[]; inline: unknown[]; expand: string[] }>(
			`const m = await import(${JSON.stringify(autocomplete)});
			const typed = ${JSON.stringify(TYPED)};
			console.log(JSON.stringify({
				suggest: typed.map(t => m.getEmojiSuggestions(t)),
				inline: typed.map(t => m.tryEmojiInlineReplace(t)),
				expand: ${JSON.stringify(MESSAGES)}.map(m.expandEmoticons),
			}));`,
		);
		const ours = {
			suggest: await Promise.all(TYPED.map(getEmojiSuggestions)),
			inline: await Promise.all(TYPED.map(tryEmojiInlineReplace)),
			expand: MESSAGES.map(expandEmoticons),
		};
		expect(ours).toEqual(stock);
		expect(stock.suggest.filter(Boolean).length).toBeGreaterThan(3);
		expect(stock.inline.filter(Boolean).length).toBeGreaterThan(10);
	}, 90_000);
});
