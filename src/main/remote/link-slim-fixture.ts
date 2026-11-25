import type { LinkSlim } from "./protocol";

/** Negotiated flags for tests that supply a connection without a handshake. */
export function linkSlimFixture(enabled: boolean): LinkSlim {
	return {
		events: enabled,
		progress: enabled,
		autopilot: enabled,
		ends: enabled,
		readGroups: enabled,
		toolResults: enabled,
		endFields: enabled,
		autopilotReads: enabled,
		listReads: enabled,
		shiftedReads: enabled,
		settingsReads: enabled,
		rosterReads: enabled,
		jobsReads: enabled,
		toolOutputs: enabled,
		toolArgs: enabled,
		deflate: enabled,
		deflateContext: enabled,
		sessionLists: enabled,
	};
}
