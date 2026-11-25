/**
 * Probe for a known session shown with no rows (the idle-release report: a released hidden tab sat on "Loading
 * earlier messages…" over a second): the key looked up now and whether the cache has it, the key the tab was seeded
 * under and the key its snapshot was last written under, with their ages. Says which of "never written", "written
 * under another key" and "not found" it was. Loaded by `import()` only when it reports, off the phone's first screen.
 */
import { readTranscriptSnapshot, transcriptKey } from "../lib/transcript-snapshot";
import { useTabsStore } from "../stores/tabs";
import { snapshotIdentity, transcriptProbe } from "./session-hydration";

/** A log-safe key: the session file's name, never its folder. */
const probeKey = (key: string | null | undefined) => (key ? key.replace(/^path:.*[\\/]/, "path:") : null);

export function reportEmptyTranscript(tabId: string): void {
	const tab = useTabsStore.getState().tabs.find(entry => entry.id === tabId);
	if (!tab) return;
	const identity = snapshotIdentity(tab);
	const hit = readTranscriptSnapshot(identity);
	const { seeded, written } = transcriptProbe.get(tabId) ?? {};
	const now = Date.now();
	window.omp?.runtime?.report({
		source: "transcript-seed",
		message: "empty",
		details: {
			level: "info",
			status: tab.status,
			key: probeKey(transcriptKey(identity)),
			found: hit !== null,
			foundAgeMs: hit ? now - hit.at : null,
			seeded: probeKey(seeded?.key),
			seededFound: seeded?.found ?? null,
			seededAgoMs: seeded ? now - seeded.at : null,
			written: probeKey(written?.key),
			writtenAgoMs: written ? now - written.at : null,
		},
	});
}
