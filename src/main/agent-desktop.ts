/**
 * What a session's omp is started with for the Computer use setting (pref `computerUse`, src/shared/computer-use.ts;
 * bridge half: resources/gui-bridge/modes/computer-use.ts), and which agent-desktop runs. Read at every spawn, so a
 * pick, or a newer copy the CLI updater installed, applies from a session's next start: the MCP root is mounted when
 * omp starts and cannot be switched live.
 *
 * Two copies can exist: the one the app ships (`<resources>/agent-desktop-bin`, the release pinned in
 * scripts/agent-desktop-pin.json, unpacked by `bun run build:agent-desktop`) and the one machine setup's updates keep
 * in the managed tools dir (src/main/setup/paths.ts `managedAgentDesktop`). The managed copy runs when its version is
 * at least the bundled one's, so an update is picked up and a stale managed copy never shadows a newer app.
 */
import { join } from "node:path";
import { AGENT_DESKTOP_ENV, COMPUTER_USE_ENV } from "../../resources/gui-bridge/modes/computer-use-contracts";
import { parseComputerUseEngine } from "../shared/computer-use";
import type { SetupPlatform } from "../shared/setup";
import { core } from "./core/process";
import { AGENT_DESKTOP_MIN_VERSION } from "./setup/archives";
import { managedAgentDesktop } from "./setup/paths";

/** An agent-desktop OMPdesk can run, and where it came from. */
export interface AgentDesktopCopy {
	source: "managed" | "bundled";
	path: string;
	version: string;
}

/** The core checks the bundle's build record and chooses the newest usable copy. */
export async function pickAgentDesktop(
	platform: "darwin" | "win32",
	bundleDir: string | undefined,
	managed?: { path: string; version: string } | { path: string; cwd: string; env: NodeJS.ProcessEnv },
): Promise<AgentDesktopCopy | null> {
	return (
		await core().call<AgentDesktopCopy | null>("setup.pickAgentDesktop", {
			platform,
			bundleDir,
			managed,
			minimum: AGENT_DESKTOP_MIN_VERSION,
		})
	).result;
}

export interface AgentDesktopSources {
	toolsDir: string;
	/** `<resources>/agent-desktop-bin` (packaged), `resources/agent-desktop-bin/<platform>-<arch>` (dev). */
	bundleDir: string;
	platform: SetupPlatform;
}

/** The copy a session started now runs (`pickAgentDesktop` over the managed and the bundled copy). */
export async function agentDesktopToRun(sources: AgentDesktopSources): Promise<AgentDesktopCopy | null> {
	const { toolsDir, bundleDir, platform } = sources;
	if (platform === "other") return null;
	return pickAgentDesktop(platform, bundleDir, {
		path: managedAgentDesktop(toolsDir, platform),
		cwd: process.cwd(),
		env: process.env,
	});
}

export interface ComputerUseSpawn {
	/** `-e <root>` of the agent-desktop MCP server, only when it will run. */
	args: string[];
	/** `COMPUTER_USE_ENV` always (the bridge reads it), `AGENT_DESKTOP_ENV` beside the root. */
	env: Record<string, string>;
}

export interface ComputerUseSpawnInput extends AgentDesktopSources {
	/** The stored pref, as read. */
	pref: unknown;
	/** `resources/omp-builtin`: the root is its `agent-desktop/` folder. */
	builtinDir: string;
}

/**
 * - `builtin`: stock's eval `computer` prelude; nothing is mounted.
 * - `agent-desktop` with a copy to run (`agentDesktopToRun`): the root and that executable's path.
 * - `agent-desktop` without one (no bundled copy, a dev run, and no managed one): nothing is mounted and the bridge
 *   keeps the built-in prelude on and says so in the session (`missing`).
 */
export async function computerUseSpawn(input: ComputerUseSpawnInput): Promise<ComputerUseSpawn> {
	if (parseComputerUseEngine(input.pref) === "builtin") return { args: [], env: { [COMPUTER_USE_ENV]: "builtin" } };
	const copy = await agentDesktopToRun(input);
	if (!copy) return { args: [], env: { [COMPUTER_USE_ENV]: "missing" } };
	return {
		args: ["-e", join(input.builtinDir, "agent-desktop")],
		env: { [COMPUTER_USE_ENV]: "agent-desktop", [AGENT_DESKTOP_ENV]: copy.path },
	};
}
