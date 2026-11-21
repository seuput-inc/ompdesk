import * as os from "node:os";

export type LowerAgentPriority = (pid: number | undefined) => void;

/** The MCP hub is still spawned by Node. A priority refusal must not fail its start. */
export const lowerAgentPriority: LowerAgentPriority = pid => {
	if (pid === undefined) return;
	try {
		os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
	} catch {
		// The process may already have exited.
	}
};
