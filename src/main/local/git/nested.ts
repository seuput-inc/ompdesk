/**
 * `get_nested_repos`: the repositories inside a folder that is not one itself, from one bounded walk in the core
 * process (`native/ompdesk/crates/core/src/git/nested.rs`). The Changes panel gives each a section, and the same list
 * adds them to the sidebar (FR40, FB45).
 */
import type { RpcNestedRepos } from "../../../shared/rpc-types";
import { coreGit } from "./exec";

export function getNestedRepos(cwd: string): Promise<RpcNestedRepos> {
	return coreGit("git.nestedRepos", { cwd }, 2);
}
