import type {} from "micromark-extension-math";
import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
import type { Construct, Effects, State, TokenizeContext, Tokenizer } from "micromark-util-types";
import type {} from "remark-parse";
import type { Processor } from "unified";
import { CJK_CHARACTER } from "./remark-cjk";

/** Recognize TeX delimiters before Markdown escapes and setext headings. */
export function remarkLatexMath(this: Processor): void {
	const data = this.data();
	data.micromarkExtensions ??= [];
	data.micromarkExtensions.push({
		flow: { 92: { tokenize: tokenizeLatexMath(true), concrete: true } },
		text: { 92: { tokenize: tokenizeInlineMath } },
	});
}

const inlineMath = tokenizeLatexMath(false);
const texShape: Construct = { tokenize: tokenizeTexShape, partial: true };
const TEX_COMMAND = /\\[A-Za-z]+/g;
/** Two plain words in a row (`the parity run`), where TeX writes one-letter variables and commands. */
const WORD_RUN = /(?<![\p{L}\p{N}])\p{L}{3,}\s+\p{L}{3,}/u;

/**
 * Markdown writers escape parentheses (`\(HWP 편집 보류, 0.125.4 포함\)`), which reads exactly as LaTeX's inline
 * delimiter; like remarkDollarMath's price rule, the span is math only when its content reads as TeX: outside
 * `{…}` groups and `\commands` it holds no CJK letter and no two plain words in a row. `\(x^2 + y\)`,
 * `\(\sin x\)` and `\(\text{유효 대역폭}\)` stay math.
 */
function tokenizeInlineMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	return effects.check(texShape, inlineMath.call(this, effects, ok, nok), nok);
}

function readsAsTex(content: string): boolean {
	let outside = "";
	let depth = 0;
	for (const char of content) {
		if (char === "{") depth++;
		else if (char === "}") depth = Math.max(0, depth - 1);
		else if (depth === 0) outside += char;
	}
	outside = outside.replace(TEX_COMMAND, " ");
	return !CJK_CHARACTER.test(outside) && !WORD_RUN.test(outside);
}

/** Looks ahead from `\(` to the `\)` the math tokenizer would close on, escapes read the same way, and judges the content. */
function tokenizeTexShape(effects: Effects, ok: State, nok: State): State {
	let content = "";
	return start;

	function start(code: number | null): State | undefined {
		effects.enter("data");
		effects.consume(code);
		return open;
	}

	function open(code: number | null): State | undefined {
		if (code !== 40) return nok(code);
		effects.consume(code);
		return inside;
	}

	function inside(code: number | null): State | undefined {
		if (code === null) return nok(code);
		effects.consume(code);
		if (code === 92) return escaped;
		content += code < 0 ? " " : String.fromCharCode(code);
		return inside;
	}

	function escaped(code: number | null): State | undefined {
		if (code === 41) {
			effects.exit("data");
			return readsAsTex(content) ? ok(code) : nok(code);
		}
		content += "\\";
		if (code === null || code < 0) return inside(code);
		effects.consume(code);
		content += String.fromCharCode(code);
		return inside;
	}
}

// Emit remark-math's existing tokens so both notations share its AST and the
// sanitized KaTeX pipeline. Micromark keeps code, HTML and escapes out of here.
function tokenizeLatexMath(display: boolean): Tokenizer {
	return (effects, ok, nok) => {
		const math = display ? "mathFlow" : "mathText";
		const fence = display ? "mathFlowFence" : "mathTextSequence";
		const value = display ? "mathFlowValue" : "mathTextData";
		const close: Construct = { tokenize: tokenizeClose, partial: true };
		return start;

		function start(code: number | null): State | undefined {
			effects.enter(math);
			effects.enter(fence);
			effects.consume(code);
			return open;
		}

		function open(code: number | null): State | undefined {
			if (code !== (display ? 91 : 40)) return nok(code);
			effects.consume(code);
			effects.exit(fence);
			return beforeData;
		}

		function beforeData(code: number | null): State | undefined {
			if (code === null) return nok(code);
			if (markdownLineEnding(code)) {
				effects.enter("lineEnding");
				effects.consume(code);
				effects.exit("lineEnding");
				return beforeData;
			}
			if (code === 92) return effects.attempt(close, after, escapedData)(code);
			effects.enter(value);
			return data(code);
		}

		function data(code: number | null): State | undefined {
			if (code === null || code === 92 || markdownLineEnding(code)) {
				effects.exit(value);
				return beforeData(code);
			}
			effects.consume(code);
			return data;
		}

		function escapedData(code: number | null): State | undefined {
			effects.enter(value);
			effects.consume(code);
			return escapedCharacter;
		}

		function escapedCharacter(code: number | null): State | undefined {
			if (code === null || markdownLineEnding(code)) return data(code);
			effects.consume(code);
			return data;
		}

		function after(code: number | null): State | undefined {
			if (display) return factorySpace(effects, end, "whitespace")(code);
			return end(code);
		}

		function end(code: number | null): State | undefined {
			if (display && code !== null && !markdownLineEnding(code)) return nok(code);
			effects.exit(math);
			return ok(code);
		}

		function tokenizeClose(closeEffects: Effects, closeOk: State, closeNok: State): State {
			return slash;

			function slash(code: number | null): State | undefined {
				closeEffects.enter(fence);
				closeEffects.consume(code);
				return bracket;
			}

			function bracket(code: number | null): State | undefined {
				if (code !== (display ? 93 : 41)) return closeNok(code);
				closeEffects.consume(code);
				closeEffects.exit(fence);
				return closeOk;
			}
		}
	};
}
