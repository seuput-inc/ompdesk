import { core } from "../core/process";

/** Read the active developer directory without invoking Apple's git trampoline or opening its install dialog. */
export async function appleDeveloperDir(env: NodeJS.ProcessEnv, timeoutMs: 5000 | 15000): Promise<string | null> {
	return core()
		.call<string | null>("setup.appleDeveloperDir", { cwd: process.cwd(), env, timeoutMs })
		.then(
			({ result }) => result,
			() => null,
		);
}
