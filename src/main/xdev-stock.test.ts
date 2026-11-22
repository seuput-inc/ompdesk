import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseXdTarget } from "../renderer/lib/xdev";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

const PATHS = [
	"xd://security_scan",
	"  XD://lsp ",
	"Xd://mcp__docs_search",
	"xd://",
	" xd:// ",
	"xd://lsp/document/symbol",
	"xd://lsp?raw",
	"xd://lsp#top",
	"xd://lsp:raw",
	"xd:/lsp",
	"xd_lsp",
	"https://example.com",
	"src/xd://lsp",
	"src/app.ts",
	"",
];

describe.skipIf(!existsSync(INSTALLED_OMP))("tool dispatch on the installed stock omp", () => {
	it("reads historical xd targets or the Bash dispatch records the renderer receives", () => {
		const stock = runBridgeProbe(
			`export default function (pi) {
				pi.on("session_start", async () => {
					try {
						const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
						if (typeof session.getToolCommandEntries !== "function") {
							const names = ${JSON.stringify(PATHS)}.map(path => pi.pi.parseXdUrl(path)?.name ?? null);
							console.error("DISPATCH=" + JSON.stringify({ names }));
						} else {
							// Stock before 19.1 exports parseXdUrl instead; it cannot load this module.
							const { toolCommandDispatches } = await import("@oh-my-pi/pi-coding-agent/tools/tool-commands");
							const bash = session.getToolByName("bash");
							const result = await bash.execute("stock-commands", {
								command: "reject --help; reject probe; resolve probe; echo done",
							});
							const plain = await bash.execute("stock-plain", { command: "echo plain" });
							console.error("DISPATCH=" + JSON.stringify({
								wire: result.details.toolCommands,
								commands: toolCommandDispatches("bash", result),
								write: toolCommandDispatches("write", result),
								plain: toolCommandDispatches("bash", plain),
							}));
						}
						process.exit(0);
					} catch (err) {
						console.error(err);
						process.exit(1);
					}
				});
			}`,
			"DISPATCH",
		);
		if ("names" in stock) {
			expect(stock.names).toEqual(PATHS.map(parseXdTarget));
			expect(stock.names).toContain("security_scan");
		} else {
			expect(stock.wire).toEqual(stock.commands);
			expect(stock.commands).toMatchObject([
				{ tool: "reject", mode: "help", exitCode: 0 },
				{ tool: "reject", mode: "execute", exitCode: 0, args: { reason: "probe" }, inner: { action: "discard" } },
				{ tool: "resolve", mode: "execute", exitCode: 1, args: { reason: "probe" } },
			]);
			expect(stock.write).toEqual([]);
			expect(stock.plain).toEqual([]);
		}
	}, 150_000);
});
