/**
 * A session's current (or last) turn's file-changing calls, cut from its transcript on the computer it runs on
 * (`sidecar.turnEdits` for a live session; the same core filter over a closed session's saved file), and what the sessions
 * one session opened changed (`agent_control_family_edits`). The opener's work board counts them with the work card's
 * own rule (`workOutcomes`), so a child's edits read as the child's card would, never through git.
 */
import type { AgentMessage, RpcGitUnlanded } from "./rpc-types";

/** The tools that write files (stock names); a bash edit is not one of them. */
export const TURN_EDIT_TOOLS: readonly string[] = ["write", "edit", "ast_edit", "apply_patch"];

export interface RpcTurnEdits {
	/** The session's folder, which relative paths in its calls are under. */
	cwd: string;
	/** When the prompt that started the turn arrived (epoch ms); null when it lies beyond what was read. */
	startedAt: number | null;
	/** Its newest message (epoch ms): a finished turn's end. */
	endedAt: number | null;
	/** The turn's assistant messages cut to their file-changing calls, and those calls' results. */
	messages: AgentMessage[];
}

/** A `get_turn_edits` answer (anything else, from an older host, says nothing). */
export function isTurnEdits(data: unknown): data is RpcTurnEdits {
	return !!data && typeof data === "object" && Array.isArray((data as RpcTurnEdits).messages);
}

/** A `get_git_unlanded` answer that names files. */
export function isGitUnlanded(data: unknown): data is RpcGitUnlanded {
	return !!data && typeof data === "object" && Array.isArray((data as RpcGitUnlanded).files);
}

/** One session the board's session opened, open or closed after its work landed, with what it changed. */
export interface FamilyMemberEdits {
	/** Its session file, else its tab id. */
	key: string;
	title: string;
	/** Running or waiting on an answer: its turn counts whenever it started. */
	live: boolean;
	/** The paired device it runs on; absent = the computer that answered. */
	device?: string;
	/** Its newest turn's edit calls; null while its omp cannot say (starting, an older host). */
	edits: RpcTurnEdits | null;
	/** What its worktree branch has not landed; null without a worktree or a branch to read. */
	unlanded: RpcGitUnlanded | null;
}

/** What `agent_control_family_edits` answers. */
export interface FamilyEdits {
	members: FamilyMemberEdits[];
}
