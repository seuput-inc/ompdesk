import { resolve } from "node:path";
import { agentDir } from "./agent-paths";
import { core } from "./core/process";

/** GUI-owned workspace for Work mode and chat tabs: a full agent outside any user project. */
export async function defaultWorkspace(create = true): Promise<string> {
	return (await core().call<string>("fs.defaultWorkspace", { agentDir: resolve(agentDir()), create })).result;
}
