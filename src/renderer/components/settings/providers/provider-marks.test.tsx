import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	diffDictionaries,
	INSTALLED_OMP_ROOT,
	missingStrings,
	readStockFacts,
} from "../../../../../scripts/omp-bump/dictionaries";
import { ProviderMark } from "./ProviderMark";
import {
	FALLBACK_PROVIDER_IDS,
	MARK_SOURCES,
	type MarkId,
	markArt,
	PROVIDER_BRANDS,
	providerBrand,
	sortProvidersByCompany,
} from "./provider-marks";

/** Every provider id stock omp 18.x lists: the auth policies (`/login`) plus the model catalog's providers. */
const STOCK_PROVIDER_IDS: readonly string[] = [
	"abliteration",
	"aiand",
	"aimlapi",
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"amazon-bedrock",
	"antigravity-cli",
	"anthropic",
	"anthropic-long-lived",
	"apple",
	"azure",
	"baseten",
	"bedrock-mantle",
	"bifrost",
	"cerebras",
	"charm-hyper",
	"chutes",
	"cline-pass",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"commandcode",
	"coralbricks",
	"coreweave",
	"cursor",
	"deepinfra",
	"deepseek",
	"devin",
	"devin-cli",
	"devin-windsurf",
	"exa",
	"factory-droid",
	"firepass",
	"fireworks",
	"github-copilot",
	"gitlab-duo",
	"gitlab-duo-agent",
	"gmi-cloud",
	"google",
	"google-antigravity",
	"google-gemini-cli",
	"google-vertex",
	"groq",
	"helmcode",
	"huggingface",
	"inception",
	"kagi",
	"kilo",
	"kimi-code",
	"kiro",
	"liquid",
	"litellm",
	"llama.cpp",
	"lm-studio",
	"local",
	"meta",
	"minimax",
	"minimax-cn",
	"minimax-code",
	"minimax-code-cn",
	"mistral",
	"modal",
	"modular",
	"moonshot",
	"muse-code",
	"nace",
	"nanogpt",
	"novita",
	"nvidia",
	"ollama",
	"ollama-cloud",
	"openai",
	"openai-codex",
	"openai-codex-device",
	"opencode-go",
	"opencode-zen",
	"openrouter",
	"otari",
	"parallel",
	"perplexity",
	"qianfan",
	"qwen-portal",
	"sakana",
	"sambanova",
	"scaleway",
	"siliconflow",
	"siliconflow-cn",
	"singularityapi-dev",
	"singularityapi-tech",
	"snowflake",
	"stencil",
	"stepfun",
	"synthetic",
	"tavily",
	"together",
	"typesafe",
	"umans",
	"venice",
	"vercel-ai-gateway",
	"vllm",
	"wafer-serverless",
	"web",
	"xai",
	"xai-oauth",
	"xiaomi",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-sgp",
	"yolo-auto",
	"zai",
	"zai-coding-plan",
	"zenmux",
	"zhipu-coding-plan",
];

describe("provider marks", () => {
	it("resolves every stock provider id to a vendored mark or to a deliberate fallback", () => {
		for (const id of STOCK_PROVIDER_IDS) {
			const known = id in PROVIDER_BRANDS;
			const fallback = FALLBACK_PROVIDER_IDS.includes(id);
			expect(known !== fallback, `${id}: needs exactly one of a mark and a fallback entry`).toBe(true);
			if (known) expect(providerBrand({ id, name: id }).mark, id).not.toBeNull();
			else expect(providerBrand({ id, name: id }).mark, id).toBeNull();
		}
	});

	it("keeps no entry for an id stock does not list", () => {
		for (const id of [...Object.keys(PROVIDER_BRANDS), ...FALLBACK_PROVIDER_IDS]) {
			expect(STOCK_PROVIDER_IDS, id).toContain(id);
		}
	});

	// Read as `bun scripts/omp-bump/extract.ts --check` reads any omp: its `/login` providers and catalog providers.
	it.skipIf(!existsSync(join(INSTALLED_OMP_ROOT, "package.json")))(
		"covers every id of the installed stock omp",
		() => {
			const facts = readStockFacts(INSTALLED_OMP_ROOT);
			expect(facts.providerIds.length).toBeGreaterThan(50);
			expect(missingStrings(diffDictionaries(facts), ["providers.mark"])).toEqual([]);
		},
		60_000,
	);

	it("names every company's marks the way the brand covers them: the big names have the real symbol", () => {
		const marks = (ids: string[]) => ids.map(id => providerBrand({ id, name: id }).mark);
		expect(
			marks(["anthropic", "openai", "openai-codex", "google", "xai", "deepseek", "openrouter", "mistral"]),
		).toEqual(["anthropic", "openai", "openai", "gemini", "xai", "deepseek", "openrouter", "mistral"]);
		expect(marks(["meta", "github-copilot", "cursor", "ollama", "lm-studio"])).toEqual([
			"meta",
			"githubcopilot",
			"cursor",
			"ollama",
			"lmstudio",
		]);
	});

	it("uses every vendored mark at least once and parses each into paths", () => {
		const used = new Set<MarkId>(Object.values(PROVIDER_BRANDS).map(brand => brand.mark));
		for (const mark of Object.keys(MARK_SOURCES) as MarkId[]) {
			expect(used.has(mark), `${mark} is vendored but no provider uses it`).toBe(true);
			const art = markArt(mark);
			expect(art.viewBox, mark).toBe("0 0 24 24");
			expect(art.paths.length, mark).toBeGreaterThan(0);
			expect(MARK_SOURCES[mark], mark).toContain('fill="currentColor"');
		}
	});

	it("draws the vendored symbol in the text color, never a fixed color", () => {
		const html = renderToStaticMarkup(<ProviderMark provider={{ id: "anthropic", name: "Anthropic" }} />);
		expect(html).toContain('data-provider-mark="anthropic"');
		expect(html).toContain('fill="currentColor"');
		expect(html).not.toMatch(/#[0-9a-f]{3,6}/i);
		const antigravity = renderToStaticMarkup(
			<ProviderMark provider={{ id: "antigravity-cli", name: "Antigravity CLI" }} />,
		);
		expect(antigravity).toContain('data-provider-mark="antigravity"');
		expect(providerBrand({ id: "antigravity-cli", name: "Antigravity CLI" }).company).toBe("Google");
	});

	it("falls back to the first letter in a hairline square for an unknown id or a custom endpoint", () => {
		const unknown = renderToStaticMarkup(<ProviderMark provider={{ id: "acme-gateway", name: "Acme Gateway" }} />);
		expect(unknown).toContain('data-provider-mark="fallback"');
		expect(unknown).toContain(">A<");
		expect(unknown).toContain("border");
		expect(unknown).not.toContain("<svg");
		// A custom endpoint that borrows a stock id still gets the neutral glyph.
		const custom = renderToStaticMarkup(<ProviderMark neutral provider={{ id: "openai", name: "openai" }} />);
		expect(custom).toContain('data-provider-mark="fallback"');
	});
});

describe("sortProvidersByCompany", () => {
	const row = (id: string, name: string) => ({ id, name });

	it("sorts by company and keeps one company's providers adjacent", () => {
		const sorted = sortProvidersByCompany([
			row("openai-codex", "OpenAI Codex"),
			row("google", "Google"),
			row("anthropic", "Anthropic"),
			row("google-gemini-cli", "Google Gemini CLI"),
			row("openai", "OpenAI"),
			row("deepseek", "DeepSeek"),
		]);
		expect(sorted.map(provider => provider.id)).toEqual([
			"anthropic",
			"deepseek",
			"google",
			"google-gemini-cli",
			"openai",
			"openai-codex",
		]);
	});

	it("places a provider with no brand by its own name among the companies", () => {
		const sorted = sortProvidersByCompany([row("zeta", "Zeta"), row("acme", "Acme Gateway"), row("meta", "Meta")]);
		expect(sorted.map(provider => provider.id)).toEqual(["acme", "meta", "zeta"]);
	});

	it("does not depend on the order the catalog arrives in", () => {
		const input = [row("groq", "Groq"), row("anthropic", "Anthropic"), row("xai", "xAI")];
		expect(sortProvidersByCompany(input)).toEqual(sortProvidersByCompany([...input].reverse()));
	});
});
