/**
 * The side panel's views, one per `PanelTab`, plus a subagent's transcript. A chunk of its own (about half a
 * megabyte of the eager bundle): PanelContainer loads it lazily, at once on the desktop and in an idle moment on a
 * paired web page, so a phone neither downloads nor parses the terminal, preview, changes and files views before its
 * first screen.
 */
import { useInspectorBot } from "../../hooks/use-chat-inspector";
import { useT } from "../../lib/i18n";
import { useTabRpc } from "../../lib/tab-rpc";
import type { PanelSubagent, PanelView as PanelViewId } from "../../stores/ui";
import { LiveAgents } from "../agents/LiveAgents";
import { BotInspectorHome } from "../bots/BotActivity";
import { BotChats } from "../bots/BotChats";
import { BotConnectorsSection } from "../bots/BotConnectors";
import { EmptyState, ErrorDetail, SkeletonRows } from "../common";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { PreviewPanel } from "../panels/PreviewPanel";
import { SubagentPanel } from "../panels/SubagentPanel";
import { BranchPullRequest } from "../panels/scm/BranchPullRequest";
import { useBranchList } from "../panels/scm/use-branch-list";
import { TerminalPanel } from "../panels/TerminalPanel";

export interface PanelViewProps {
	panelTab: PanelViewId;
	subagent: PanelSubagent | null;
}

function WorkspaceChecks() {
	const t = useT();
	const { list, error } = useBranchList(useTabRpc(), true);
	if (error) return <ErrorDetail error={error} />;
	if (!list) return <SkeletonRows label={t("common.loading")} widths={[70, 56, 64]} />;
	const current = list.find(branch => branch.current);
	return current ? (
		<BranchPullRequest branch={current.name} standalone />
	) : (
		<EmptyState title={t("diffPanel.pr.none")} />
	);
}

export function PanelView({ panelTab, subagent }: PanelViewProps) {
	const bot = useInspectorBot();
	const t = useT();
	return (
		<>
			{panelTab === "terminal" && <TerminalPanel />}
			{panelTab === "preview" && <PreviewPanel />}
			{panelTab === "diff" && <DiffPanel />}
			{panelTab === "files" && <FilesPanel />}
			{panelTab === "agents" && <LiveAgents />}
			{panelTab === "checks" && <WorkspaceChecks />}
			{panelTab === "bot-home" && bot && <BotInspectorHome bot={bot} />}
			{panelTab === "bot-chats" && bot && <BotChats bot={bot} />}
			{panelTab === "bot-connectors" &&
				bot &&
				(bot.device ? (
					<EmptyState title={t("panel.inspector.remoteConnectors")} />
				) : (
					<div className="overflow-auto p-4">
						<BotConnectorsSection bot={bot} />
					</div>
				))}
			{panelTab === "subagent" && <SubagentPanel subagent={subagent} />}
		</>
	);
}
