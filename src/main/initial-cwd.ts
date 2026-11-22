import { homedir } from "node:os";
import { core } from "./core/process";

export async function startupCwd(
	lastProject: string | null | undefined,
	argv = process.argv.slice(2),
	cwd = process.cwd(),
	home = homedir(),
): Promise<{ cwd: string; explicit: boolean }> {
	return (await core().call<{ cwd: string; explicit: boolean }>("fs.initialCwd", { lastProject, argv, cwd, home }))
		.result;
}
