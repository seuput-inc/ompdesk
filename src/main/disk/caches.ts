/** Main supplies the session PATH and tool lookup. The disk core owns cache locations, bounds and clears. */
import * as os from "node:os";
import * as path from "node:path";
import type { DiskCareActionKind, DiskPartId } from "../../shared/disk-care";
import { coreHeld } from "../local/git/exec";
import { bunInstallDir } from "../setup/paths";
import { shellSpawnEnv } from "../shell-env";
import { executableName, findOnPath, launcherNames } from "../spawn";

const TOOL_MS = 130_000;

/** How disk care reaches the tools whose caches it bounds. */
export interface CacheTools {
	/** The environment sessions' tools run with: the app's, plus what the login shell exports. */
	env(): Promise<NodeJS.ProcessEnv>;
	/** The tool's executable on that environment's PATH, or null. */
	find(name: "bun" | "npm"): Promise<string | null>;
	/** `ps -axo command=`, unavailable on Windows. */
	ps: string | null;
}

type CachePart = Extract<DiskPartId, "bunCache" | "bunTranspilerCache" | "npmCache">;
type CacheAction = Extract<DiskCareActionKind, "bun-cache" | "bun-transpiler-cache" | "npm-cache">;
export type CacheHolds = Partial<Record<CachePart, string>>;

export interface LocatedCache {
	cache: { part: CachePart; action: CacheAction; maxBytes: number; checkProcesses: boolean };
	dir: string;
}

interface Tool {
	bin: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

async function tool(name: "bun" | "npm", tools: CacheTools): Promise<Tool | null> {
	const bin = await tools.find(name);
	return bin ? { bin, cwd: os.homedir(), env: await tools.env() } : null;
}

export async function locateCaches(
	tools: CacheTools,
	platform: NodeJS.Platform = process.platform,
): Promise<LocatedCache[]> {
	const env = await tools.env().catch(() => null);
	const home = os.homedir();
	const named = env?.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
	return coreHeld<LocatedCache[]>(
		"disk.locateCaches",
		{
			cwd: process.cwd(),
			bun: env && {
				install: path.normalize(bunInstallDir(env, home)),
				cache: env.BUN_INSTALL_CACHE_DIR,
				transpiler: named && named !== "0" ? path.resolve(named) : named,
				xdg: env.XDG_CACHE_HOME && path.normalize(env.XDG_CACHE_HOME),
				home: path.normalize((platform === "win32" ? env.USERPROFILE : env.HOME) || home),
				mac: platform === "darwin",
			},
			npm: await tool("npm", tools).catch(() => null),
		},
		TOOL_MS,
	);
}

export function cacheHolds(tools: CacheTools): Promise<CacheHolds> {
	return coreHeld(
		"disk.cacheHolds",
		{
			ps: tools.ps && { bin: tools.ps, cwd: os.homedir(), env: process.env },
		},
		TOOL_MS,
	);
}

export async function clearCache({ cache, dir }: LocatedCache, tools: CacheTools): Promise<string | null> {
	return coreHeld(
		"disk.clearCache",
		{
			part: cache.part,
			dir,
			bun: cache.part === "bunCache" ? await tool("bun", tools) : null,
		},
		30 * 60_000,
	);
}

/** The tools as this computer has them. */
export function systemCacheTools(platform: NodeJS.Platform = process.platform): CacheTools {
	const env = async (): Promise<NodeJS.ProcessEnv> => ({ ...process.env, ...(await shellSpawnEnv(platform)) });
	return {
		env,
		find: async name => {
			const spawnEnv = await env();
			const extra =
				name === "bun"
					? [path.join(bunInstallDir(spawnEnv, os.homedir()), "bin", executableName("bun", platform))]
					: [];
			return findOnPath(launcherNames(name, platform), spawnEnv.PATH ?? "", platform, extra);
		},
		ps: platform === "win32" ? null : "ps",
	};
}
