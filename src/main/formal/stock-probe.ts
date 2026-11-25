/**
 * Run by `formal-stock.test.ts` and `interfaces-stock.test.ts` under Bun (stock omp's source needs Bun's runtime):
 * builds a real omp session with the given extension roots in the caller's isolated HOME and agent dir and prints, as
 * one JSON line, what the bundled skills cost and expose. Args: `<omp package root> <cwd> <extension root>...`;
 * `STOCK_PROBE_READ` (comma-separated `skill://` URLs) names what to read, else the formal skill's;
 * `STOCK_PROBE_INVOKE` (JSON `[name, args][]`) renders those `/skill:<name> <args>` prompts as stock sends them.
 */
export {};

const [packageRoot, cwd, ...roots] = process.argv.slice(2);
// The installed omp's own modules: the package root is only known at run time, so no static import can name them.
const { createAgentSession } = await import(`${packageRoot}/src/sdk.ts`);
const { SkillProtocolHandler } = await import(`${packageRoot}/src/internal-urls/skill-protocol.ts`);
const { parseInternalUrl } = await import(`${packageRoot}/src/internal-urls/parse.ts`);
const { buildSkillPromptMessage } = await import(`${packageRoot}/src/extensibility/skills.ts`);

const { session } = await createAgentSession({
	cwd,
	additionalExtensionPaths: roots,
	disableExtensionDiscovery: true,
	// Measure the prompt as built, without starting background model jobs to rewrite its skill descriptions.
	deferHintCompression: true,
});
const skills: { name: string; filePath: string; hide?: boolean; disableModelInvocation?: boolean }[] = [
	...session.skills,
];
const handler = new SkillProtocolHandler();
const read: Record<string, string> = {};
const urls = process.env.STOCK_PROBE_READ?.split(",") ?? [
	"skill://ompdesk-formal-verify",
	"skill://ompdesk-formal-verify/references/workflows.md",
];
for (const url of urls) {
	try {
		const resource = await handler.resolve(parseInternalUrl(url), { skills });
		read[url] = String(resource.content ?? "").slice(0, 300);
	} catch (error) {
		read[url] = `error: ${error instanceof Error ? error.message : String(error)}`;
	}
}
const invoked: string[] = [];
for (const [name, args] of JSON.parse(process.env.STOCK_PROBE_INVOKE ?? "[]") as [string, string][]) {
	const skill = session.skills.find((entry: { name: string }) => entry.name === name);
	invoked.push(skill ? (await buildSkillPromptMessage(skill, { args }, "user")).message : `error: no skill ${name}`);
}
const breakdown = await session.getContextBreakdown();
console.log(
	JSON.stringify({
		usedTokens: breakdown.usedTokens,
		skillsTokens: breakdown.skillsTokens,
		skills: skills.map(skill => ({
			name: skill.name,
			path: skill.filePath,
			hidden: skill.hide === true || skill.disableModelInvocation === true,
		})),
		read,
		invoked,
	}),
);
await session.dispose();
process.exit(0);
