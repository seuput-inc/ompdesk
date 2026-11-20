import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "../shared/rpc-types";
import { runStock, stockSource } from "./test-bridge-probe";

const manager = stockSource("pi-catalog", "model-manager.ts");
export const hasCodexProbe = !!manager;

/** Run stock's real discovery and cache with synthetic accounts and an in-memory /models responder. */
export function codexPickerSequence() {
	const file = (pkg: string, subpath: string) => JSON.stringify(stockSource(pkg, subpath));
	const home = mkdtempSync(join(tmpdir(), "picker-"));
	const bridge = join(home, "bridge");
	mkdirSync(join(bridge, "omp/pi-coding-agent/slash-commands/helpers"), { recursive: true });
	for (const name of ["codex-picker.ts", "codex-picker-contracts.ts"])
		copyFileSync(join("resources/gui-bridge", name), join(bridge, name));
	// Plain Bun does not have omp's bridge module resolver. Bind the same two exports to the installed stock source.
	writeFileSync(join(bridge, "omp/pi-ai.ts"), `export {getEnvApiKeyName} from ${file("pi-ai", "env-api-key.ts")}`);
	writeFileSync(
		join(bridge, "omp/pi-coding-agent/slash-commands/helpers/logout.ts"),
		`export {listLogoutAccounts} from ${file("pi-coding-agent", "slash-commands/helpers/logout.ts")}`,
	);
	return runStock<Record<"a" | "firstFailure" | "b" | "limited" | "mixed", ModelInfo[]> & { extraReads: number }>(`
		Object.assign(process.env, { HOME: ${JSON.stringify(home)}, PI_CONFIG_DIR: ".", PI_AI_CODEX_CLIENT_VERSION: "1.0.0" });
		process.env.USERPROFILE = process.env.HOME;
		delete process.env.OPENAI_CODEX_OAUTH_TOKEN;
		globalThis.fetch = () => { throw Error("external network disabled"); };
		const {openaiCodexModelManagerOptions} = await import(${file("pi-catalog", "provider-models/special.ts")});
		const {resolveProviderModels} = await import(${JSON.stringify(manager)});
		const {pickerAccounts, pickerAvailability, refreshForeignCatalog} = await import(${JSON.stringify(join(bridge, "codex-picker.ts"))});
		let id = "A", fail = false, mixed = false, reads = 0, rows = [];
		const opts = {...openaiCodexModelManagerOptions({
			resolveAccounts: async () => [{accountId: id, accessToken: "fixture"}],
			fetch: async (_url, init) => {
				if (init.method !== "GET") throw Error("only model lists allowed");
				reads++;
				return fail ? new Response(null, {status:429}) : Response.json({models:[
					{slug:"fixture-common"}, {slug:"fixture-private", visibility: id === "A" ? "list" : "hide"}
				]});
			}
		}), staticModels: [], cacheDbPath: process.env.HOME + "/models.sqlite"};
		const read = async strategy => { rows = (await resolveProviderModels(opts, strategy)).models; };
		const session = {sessionId: "fixture", getAvailableModels: () => rows, modelRegistry: {
			hasCommandBackedApiKey: () => false,
			refreshDiscoverableProviders: (ids, strategy) => {
				if (ids.join() !== "openai-codex" || strategy !== "online") throw Error("wrong scope");
				return read(strategy);
			},
			authStorage: {
				keys: {source: () => ({kind:"oauth"})},
				oauth: {identity: () => undefined, accounts: () => [{accountId:id}]},
				credentials: { get generation() { return (id === "A" ? 0 : 1) + (mixed ? 2 : 0); }, reload: async () => {}, list: () => [
					{id:1, credential:{type:"oauth", accountId:id}}, ...(mixed ? [{id:2, credential:{type:"api_key"}}] : [])
				]}
			}
		}};
		const image = async () => {
			const ids = await pickerAccounts(session, rows);
			return rows.map(row => ({provider:row.provider, id:row.id, name:row.id, pickerAvailability:pickerAvailability(row,ids)}));
		};
		await read("online"); await refreshForeignCatalog(session,true); const a = await image();
		mixed = true; const mixedRows = await image(); mixed = false;
		id = "B"; fail = true; await read("online-if-uncached"); const warmReads = reads; await refreshForeignCatalog(session,false);
		if (reads === warmReads) throw Error("the switched account was never queried");
		const firstFailure = await image();
		const afterFailure = reads; await refreshForeignCatalog(session,false); const repeatFailed = reads-afterFailure;
		fail = false; await refreshForeignCatalog(session,false,true); const b = await image();
		const beforeOpen = reads; await read("online-if-uncached"); await refreshForeignCatalog(session,false);
		const extraReads = reads-beforeOpen + repeatFailed;
		fail = true; await read("online"); const limited = await image();
		id = "A"; fail = false; await read("online"); await refreshForeignCatalog(session,true);
		id = "B"; await read("online-if-uncached"); await refreshForeignCatalog(session,false);
		if (rows.some(row => row.id === "fixture-private")) throw Error("automatic refresh kept the previous account's row");
		console.log(JSON.stringify({a, firstFailure, b, limited, mixed:mixedRows, extraReads}));
	`);
}
