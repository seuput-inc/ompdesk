import { afterEach, expect, it, vi } from "vitest";
import { CLAUDE_API_URL, offeredClaudeModels } from "../../resources/gui-bridge/claude-key-models";

const key = "offline-discovery-key";
afterEach(() => vi.unstubAllGlobals());

it("reads every page for the same key without following redirects or sending a prompt", async () => {
	const requests: Request[] = [];
	vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
		requests.push(new Request(url, init));
		return Response.json(
			requests.length === 1
				? { data: [{ id: "first", display_name: "First model" }], has_more: true, last_id: "cursor+/1" }
				: { data: [{ id: "second" }], has_more: false },
		);
	});
	expect(Array.from(await offeredClaudeModels(CLAUDE_API_URL, key))).toEqual([
		["first", "First model"],
		["second", "second"],
	]);
	expect(requests.map(r => new URL(r.url).searchParams.get("after_id"))).toEqual([null, "cursor+/1"]);
	for (const r of requests) {
		expect(r.method).toBe("GET");
		expect(new URL(r.url).origin + new URL(r.url).pathname).toBe(`${CLAUDE_API_URL}/v1/models`);
		expect(r.redirect).toBe("error");
		expect(r.headers.get("x-api-key")).toBe(key);
		expect(r.headers.get("authorization")).toBeNull();
		expect(r.headers.get("anthropic-version")).toBe("2023-06-01");
	}
});

it.each([
	() => new Response(key, { status: 401 }),
	() => Response.json({ data: [{ id: "one" }], has_more: true, last_id: "one" }),
	() => Response.json({ data: [{ id: "one" }, {}], has_more: false }),
	() => Response.json({ data: [{ id: "one", display_name: `echo: ${key}` }], has_more: false }),
	() => {
		throw new TypeError(key);
	},
])("never returns a partial catalog or reflects provider errors", async response => {
	vi.stubGlobal("fetch", vi.fn(response));
	await expect(offeredClaudeModels(CLAUDE_API_URL, key)).rejects.toThrow(
		/^Could not read the models available to this Claude API key$/,
	);
});

it("refuses a different destination without making a request", async () => {
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	await expect(offeredClaudeModels("https://api.anthropic.com.invalid", key)).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});
