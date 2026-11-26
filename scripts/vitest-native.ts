/**
 * Vitest globalSetup of the node project: OMPdesk's own native binaries (`bun run build:native`) are staged and this
 * checkout's build before any test runs, so every test that reaches the core process (`src/main/core/process.ts`) or
 * runs the CLI finds them. A fresh staging only hashes the sources; a stale one is built once per run, except on a
 * computer that cannot hold a cargo release build beside the test run: there the run stops with one line pointing at CI.
 */
import { buildNative, checkNative } from "./build-native";
import { heavyPoolSize } from "./lock-slots";

/**
 * The line that stops a run instead of building `stale` binaries, or undefined where a local cargo build is fine: a
 * GitHub runner, or a computer whose heavy pool holds two commands or more (this test run is already one; on 16 GB a
 * `cargo build --release --workspace` beside it swapped the Mac). `OMPDESK_NO_LOCAL_CARGO=1` refuses on any computer.
 */
export async function localCargoRefusal(stale: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (env.GITHUB_ACTIONS) return undefined;
	const why =
		env.OMPDESK_NO_LOCAL_CARGO === "1"
			? "OMPDESK_NO_LOCAL_CARGO=1"
			: (await heavyPoolSize(env)) < 2
				? "this computer runs one heavy command at a time"
				: undefined;
	if (!why) return undefined;
	return `vitest: native binaries need a cargo build, refused here (${why}): ${stale} Run the node tests on GitHub: bun scripts/ci-run.ts ci --ref <branch> -f batch=true`;
}

export default async function setup(): Promise<void> {
	let stale: string;
	try {
		checkNative();
		return;
	} catch (error) {
		// Not a helper in build-native.ts: that file is in the native source hash, so editing it stales every staging.
		stale = error instanceof Error ? error.message : String(error);
	}
	const refusal = await localCargoRefusal(stale, process.env);
	if (refusal) throw new Error(refusal);
	buildNative({ quiet: true });
}
