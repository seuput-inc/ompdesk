import { type SummaryRequest, unsavedSessionKey } from "../../../../shared/session-summary";
import { useHostedSessionsStore } from "../../../stores/hosted-sessions";

/** The host's live summary for the WorkBoard and WorkBoardChip test pane. */
export function showBoardRequests(...requests: Pick<SummaryRequest, "id" | "label" | "kind">[]): void {
	useHostedSessionsStore.setState({
		summaries: {
			"": {
				version: "test.1",
				sessions: [
					{
						sessionPath: unsavedSessionKey("t1"),
						tabId: "t1",
						cwd: "/w",
						status: "ready",
						kind: "agent",
						agents: [],
						ask: requests[0]?.kind,
						requests: requests.map((request, askedAt) => ({ ...request, askedAt })),
					},
				],
			},
		},
	});
}
