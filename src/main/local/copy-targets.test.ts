import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentMessage, CopyTarget } from "../../shared/rpc-types";

const stockScope = path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi");
const stockPath = path.join(stockScope, "pi-coding-agent/src/modes/view-model/overlays/copy-targets.ts");
const lexerPath = path.join(stockScope, "pi-tui/src/text/markdown/lexer.ts");
const selectorPath = path.join(stockScope, "pi-coding-agent/src/ui/overlays/pickers/copy-selector.tsx");
const adapterPath = path.resolve("resources/gui-bridge/copy-targets.ts");

/** Runs `body` in Bun (stock includes Bun-native dependencies) with `stock`, `lexMarkdown` and the adapter in scope. */
function inBun<T>(body: string): T {
	const result = spawnSync(
		"bun",
		[
			"--eval",
			`
		const stock = await import(${JSON.stringify(stockPath)});
		const { lexMarkdown } = await import(${JSON.stringify(lexerPath)});
		const adapter = await import(${JSON.stringify(adapterPath)});
		${body}
	`,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(result.stderr);
	return JSON.parse(result.stdout) as T;
}

function targetsFor(messages: AgentMessage[]): CopyTarget[] {
	return inBun(
		`console.log(JSON.stringify(adapter.buildCopyTargets(${JSON.stringify(messages)}, { ...stock, lexMarkdown })));`,
	);
}

const assistant = (text: string, toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = []) =>
	({
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCalls.map((call, index) => ({ type: "toolCall" as const, id: `t${index}`, ...call })),
		],
	}) satisfies AgentMessage;

describe.skipIf(!existsSync(stockPath) || !existsSync(lexerPath))(
	"copy picker using installed stock extraction",
	() => {
		it("finds the code and quote blocks stock's /copy finds in a message", () => {
			const texts = [
				"> q1\n> q2\n\n```ts\nx\n```\n\n    indented\n\n- item\n  ```sh\n  y\n  ```\n- > listed quote\n",
				"> quoted\n>tight\n```ts\n> not a quote\n```\n```js\nunclosed",
				"text only, `inline` code and [a link](https://example.com)",
				"> ```py\n> inside a quote\n> ```\n\n1. one\n   ```\n   two\n   ```",
			];
			const [ours, theirs] = inBun<[unknown[], unknown[]]>(`
			const { collectBlocks } = await import(${JSON.stringify(selectorPath)});
			const texts = ${JSON.stringify(texts)};
			const ours = texts.map(text => adapter.markdownBlocks(lexMarkdown(text)));
			const theirs = texts.map(text => collectBlocks({ turnId: "e", isUserTurn: false, entries: [
				{ id: "e", type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
			] })
				.filter(block => block.kind === "code" || block.kind === "quote")
				.map(block => block.kind === "code"
					? { kind: "code", lang: block.language ?? "", code: block.content }
					: { kind: "quote", text: block.content }));
			console.log(JSON.stringify([ours, theirs]));
		`);
			expect(ours).toEqual(theirs);
		});

		it("ranks messages newest first with code children and the commands each turn ran", () => {
			const targets = targetsFor([
				assistant("older answer"),
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "ls -la" } }],
				},
				assistant("```sh\necho 1\n```\n```py\nprint(2)\n```", [
					{ name: "eval", arguments: { cells: [{ code: "1+1", language: "js" }] } },
				]),
			]);
			expect(targets.map(target => target.id)).toEqual(["msg:1", "cmd:1", "msg:2", "cmd:2"]);
			expect(targets[0]?.children?.map(child => child.id)).toEqual(["msg:1:code:0", "msg:1:code:1", "msg:1:all"]);
			expect(targets[0]?.children?.[2]?.content).toBe("echo 1\n\nprint(2)");
			expect(targets[1]).toMatchObject({ content: "1+1", language: "javascript" });
			expect(targets[2]).toMatchObject({ label: "older answer" });
			expect(targets[3]).toMatchObject({ content: "ls -la", language: "bash" });
		});

		it("keeps stock quote extraction and masks quotes inside fences", () => {
			const targets = targetsFor([assistant("> quoted\n>tight\n```ts\n> not a quote\n```\n```js\nunclosed")]);
			const children = targets[0]?.children ?? [];
			// The one quote is stock's; a `>` line inside a fence stays that block's code. What else stock offers beside them
			// (18.18 adds an unclosed fence's block and an "All N blocks" child) is stock's to choose.
			expect(children.filter(child => child.id.includes(":quote:")).map(child => child.content)).toEqual([
				"quoted\ntight",
			]);
			expect(children.find(child => child.language === "ts")?.content).toBe("> not a quote");
		});

		it("falls back to the displayed handoff when no assistant text exists", () => {
			const targets = targetsFor([
				{ role: "custom", customType: "handoff", display: true, content: [{ type: "text", text: "ctx\nmore" }] },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "x", name: "bash", arguments: { command: "pwd" } }],
				},
			]);
			expect(targets.map(target => target.id)).toEqual(["handoff", "cmd:1"]);
			expect(targets[0]?.content).toBe("ctx\nmore");
		});
	},
);
