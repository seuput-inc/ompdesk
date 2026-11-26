/**
 * The paired computer a bot lives on (orca-bots-remote), in small muted text beside its name, as a host's sessions show
 * their host: nothing for this computer's own bots. While that computer is away it reads "<host> · offline".
 */
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { useLostHosts, usePairedHosts } from "../../stores/remote";

/**
 * The paired computers whose bots read offline: the link stayed lost past the grace (`useLostHosts`), or this computer
 * keeps a last copy of a computer it has no link to at all.
 */
export function useOfflineBotHosts(): ReadonlySet<string> {
	const lost = useLostHosts();
	const hosts = usePairedHosts();
	const remote = useBotsStore(s => s.state.remote);
	const offline = new Set(lost);
	for (const copy of remote ?? [])
		if (!copy.online && !hosts.some(host => host.deviceId === copy.device)) offline.add(copy.device);
	return offline;
}

/** The name a paired computer's bots show: its live name, else the one its last copy came with. */
export function useBotHostName(device: string | undefined): string {
	const live = usePairedHosts().find(host => host.deviceId === device)?.name;
	const kept = useBotsStore(s => (device ? s.state.remote?.find(copy => copy.device === device)?.name : undefined));
	return live ?? kept ?? "";
}

export function BotOwner({ device, className }: { device: string | undefined; className?: string }) {
	const t = useT();
	const name = useBotHostName(device);
	const offline = useOfflineBotHosts();
	if (!device) return null;
	const away = offline.has(device);
	return (
		<span
			className={cx("min-w-0 shrink truncate text-sc-xs font-normal text-(--sc-text-muted)", className)}
			data-bot-offline={away ? "" : undefined}
			data-bot-owner={device}
		>
			{away ? t("bots.remote.ownerOffline", { device: name }) : name}
		</span>
	);
}
