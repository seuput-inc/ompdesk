import { resolve } from "node:path";
import type { RpcGitFingerprint } from "../shared/rpc-types";
import { coreGit } from "./local/git/exec";

export const gitFingerprints = {
	read(cwd: string, knownRoot?: string): Promise<RpcGitFingerprint> {
		const key = resolve(cwd);
		return coreGit("git.watchedFingerprint", { cwd, key: key === cwd ? undefined : key, root: knownRoot }, 2);
	},
};
