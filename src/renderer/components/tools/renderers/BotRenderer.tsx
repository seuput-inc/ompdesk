/**
 * `ompdesk_bot` in the transcript: an `offer_connector` (FM64, Orca `NativeChatConnectorOfferCard.tsx:103-160`) is the
 * Connect card whose button opens that connector's setup for the bot whose chat this is; any other action, a failure,
 * or an offer outside a bot's own chat on this computer keeps the generic view.
 */
import { useEffect } from "react";
import { BOT_CONNECTOR_SERVICES } from "../../../../shared/bot-connectors";
import { useT } from "../../../lib/i18n";
import { botOfFolder, ensureBots, useBotsStore } from "../../../stores/bots";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { ConnectorOfferCard } from "../../bots/BotConnectors";
import { Banner } from "../../common";
import type { ToolRendererProps } from "../ToolCard";
import { GenericRenderer } from "./GenericRenderer";

export function BotRenderer(props: ToolRendererProps) {
	const { args, isError, isPartial } = props;
	const t = useT();
	const tabId = useRuntimeTabId();
	const tab = useTabsStore(s => s.tabs.find(tab => tab.id === tabId));
	const bot = useBotsStore(s => botOfFolder(s.state.bots, tab?.cwd));
	const service =
		args.action === "offer_connector" && !isError && !isPartial
			? BOT_CONNECTOR_SERVICES.find(known => known === args.service)
			: undefined;
	const localOffer = !!service && !tab?.device;
	useEffect(() => {
		if (localOffer) ensureBots();
	}, [localOffer]);
	if (!service) return <GenericRenderer {...props} />;
	// A remote chat can share a folder spelling with an unrelated bot here. Never open local setup for it.
	if (tab?.device)
		return (
			<Banner data-connector-offer={service} variant="neutral">
				{t("bots.connectors.offer.onHost", { service: t(`bots.connectors.service.${service}`) })}
			</Banner>
		);
	return bot ? <ConnectorOfferCard bot={bot} service={service} /> : <GenericRenderer {...props} />;
}
