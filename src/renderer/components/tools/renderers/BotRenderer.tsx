/**
 * `ompdesk_bot` in the transcript: an `offer_connector` (FM64, Orca `NativeChatConnectorOfferCard.tsx:103-160`) is the
 * Connect card whose button opens that connector's setup for the bot whose chat this is; any other action, a failure,
 * or an offer outside a bot's own chat on this computer keeps the generic view.
 */
import { BOT_CONNECTOR_SERVICES } from "../../../../shared/bot-connectors";
import { useBotsStore } from "../../../stores/bots";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { ConnectorOfferCard } from "../../bots/BotConnectors";
import type { ToolRendererProps } from "../ToolCard";
import { GenericRenderer } from "./GenericRenderer";

export function BotRenderer(props: ToolRendererProps) {
	const { args, isError, isPartial } = props;
	const tabId = useRuntimeTabId();
	const cwd = useTabsStore(s => s.tabs.find(tab => tab.id === tabId)?.cwd);
	const bot = useBotsStore(s => s.state.bots.find(known => cwd !== undefined && known.folder === cwd));
	const service = BOT_CONNECTOR_SERVICES.find(known => known === args.service);
	if (args.action !== "offer_connector" || isError || isPartial || !service || !bot)
		return <GenericRenderer {...props} />;
	return <ConnectorOfferCard bot={bot} service={service} />;
}
