/**
 * What the all-sessions page reads: this computer's session list and every online paired computer's, with each
 * computer's summaries (`stores/hosted-sessions.ts`, the one source of what a session is doing). The lists are the
 * sidebar's own feeds (`stores/session-list.ts`): held while the page shows, read once per change.
 */
import { useEffect, useMemo, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useSessionList } from "../../hooks/use-session-list";
import { LOCAL_SUMMARIES, summariesOf, useHostedSessionsStore } from "../../stores/hosted-sessions";
import { usePairedHosts } from "../../stores/remote";
import { sessionListFeed } from "../../stores/session-list";
import type { BoardComputer } from "./board-cards";

const NO_ROWS: readonly SessionInfo[] = [];

export function useBoardComputers(): BoardComputer[] {
	const hosts = usePairedHosts();
	const { sessions: local } = useSessionList("global");
	const summaries = useHostedSessionsStore(state => state.summaries);
	const online = useMemo(
		() =>
			hosts
				.filter(host => host.state === "online")
				.map(host => host.deviceId)
				.join("\n"),
		[hosts],
	);
	const [hostLists, setHostLists] = useState<ReadonlyMap<string, readonly SessionInfo[]>>(new Map());
	useEffect(() => {
		const feeds = (online ? online.split("\n") : []).map(id => ({ id, feed: sessionListFeed("global", id) }));
		const read = () => setHostLists(new Map(feeds.map(({ id, feed }) => [id, feed.store.getState().sessions])));
		const releases = feeds.map(({ feed }) => feed.retain());
		const stops = feeds.map(({ feed }) => feed.store.subscribe(read));
		read();
		return () => {
			for (const stop of stops) stop();
			for (const release of releases) release();
		};
	}, [online]);
	return useMemo(
		() => [
			{ sessions: local, summaries: summaries[LOCAL_SUMMARIES]?.sessions ?? [] },
			// A computer whose link is down shows nothing: its last summaries may be long over.
			...hosts
				.filter(host => host.state === "online")
				.map(host => ({
					device: host.deviceId,
					name: host.name,
					sessions: hostLists.get(host.deviceId) ?? NO_ROWS,
					summaries: summariesOf({ summaries }, host.deviceId),
				})),
		],
		[local, summaries, hosts, hostLists],
	);
}
