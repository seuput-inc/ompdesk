import { useEffect, useState } from "react";
import { type Bot, canChooseLegacyPeers } from "../../../shared/bots";
import { useBotsAvailable } from "../../lib/bots-source";
import { useT } from "../../lib/i18n";
import { ensureBots, refreshBots, useBotsStore } from "../../stores/bots";
import { Banner, Button } from "../common";

function PeerRequest({ bot, device }: { bot: Bot; device: string }) {
	const t = useT();
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);
	const choose = async (allow: boolean) => {
		setSaving(true);
		setFailed(false);
		try {
			await useBotsStore.getState().command({ action: "allowLegacyPeers", ids: [bot.id], allow });
		} catch {
			setFailed(true);
			// Another owner window may already have chosen; reload rather than replaying this choice.
			refreshBots();
		} finally {
			setSaving(false);
		}
	};
	return (
		<Banner
			aria-label={bot.name}
			data-legacy-peer-request={bot.id}
			role="group"
			variant="neutral"
			actions={
				<>
					<Button disabled={saving} onClick={() => void choose(true)} size="sm" variant="secondary">
						{t("bots.access.allowPeers")}
					</Button>
					<Button disabled={saving} onClick={() => void choose(false)} size="sm" variant="secondary">
						{t("bots.access.keepPrivate")}
					</Button>
				</>
			}
		>
			{t("bots.access.legacyRequest", { bot: bot.name, device })}
			{failed && <p role="alert">{t("bots.access.choiceFailed")}</p>}
		</Banner>
	);
}

/** The desktop shell mounts this outside the current page. Only a live, locally owned bot offers a choice. */
export default function LegacyPeerRequests() {
	const available = useBotsAvailable();
	const bots = useBotsStore(s => (s.live ? s.state.bots : null));
	useEffect(() => {
		if (available) ensureBots();
	}, [available]);
	if (!available || !bots) return null;
	return (
		<div className="flex max-h-[35vh] shrink-0 flex-col gap-1 overflow-y-auto px-3 py-1 empty:hidden">
			{bots.map(bot =>
				bot.legacyPeerRequest && canChooseLegacyPeers(bot) ? (
					<PeerRequest bot={bot} device={bot.legacyPeerRequest} key={bot.id} />
				) : null,
			)}
		</div>
	);
}
