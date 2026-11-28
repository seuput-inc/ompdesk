/**
 * What the desktop status bar holds (Orca's `StatusBarSurface`, the owner's decision of 25 Nov 2026): a summary of
 * this tab's accounts' usage whose click opens the usage block over the bar (the block's desktop home: a phone or
 * tablet page keeps it in the sidebar footer), the paired computers' link, and an app update on its way. Each item
 * hides from the bar's own context menu (right click, Shift+F10), never in Settings (`sidebarFolds.statusHidden`,
 * device-local). Its own chunk, so the phone's first screen, which has no status bar, never loads it.
 */
import { ArrowUpCircle, Gauge, MonitorSmartphone } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useMemo, useRef, useState } from "react";
import { useUsageReports } from "../../../hooks/use-usage-reports";
import { useT } from "../../../lib/i18n";
import { accountGauges } from "../../../lib/usage-windows";
import { useModelStore } from "../../../stores/model";
import { usePairedHosts } from "../../../stores/remote";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useUiStore } from "../../../stores/ui";
import { useUpdaterStore } from "../../../stores/updater";
import { anchorFromEvent, Button, ContextMenu, type ContextMenuAnchor, Popover, StatusDot } from "../../common";
import { quotaLimits } from "../../settings/providers/AccountQuota";
import { shortProviderName } from "../../settings/providers/provider-groups";
import { SessionUsage } from "../SessionUsage";
import { accountStanding, SidebarUsage, sourceOf } from "../sidebar/SidebarUsage";
import { usageAccountGroups } from "../sidebar/usage-groups";

const STATUS_ITEMS = ["usage", "link", "update", "session"] as const;
type StatusItem = (typeof STATUS_ITEMS)[number];

const ITEM_LABEL_KEY: Record<StatusItem, string> = {
	usage: "sidebar.pin.usage",
	link: "statusBar.link",
	update: "statusBar.update",
	session: "sessionStatus.title",
};

const SEGMENT = "h-5 gap-1 rounded-(--sc-radius-sm) px-1.5 text-sc-xs font-normal text-(--sc-text-muted)";

/** Per provider: its short name and the in-use account's tightest window, as a share of its limit; a click opens the block. */
function UsageItem() {
	const t = useT();
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const provider = useModelStore(s => s.model?.provider ?? null);
	const providers = useModelStore(s => s.providers);
	const reports = useUsageReports();
	const chips = useMemo(
		() =>
			(reports ? usageAccountGroups(reports, provider, false) : []).map(group => {
				const account = group.accounts.find(entry => entry.inUse) ?? group.accounts[0];
				const source = sourceOf(account.report, account.inUse);
				const fraction = Math.max(0, ...accountGauges(quotaLimits(source)).map(gauge => gauge.fraction));
				const info = providers.find(entry => entry.id === group.provider);
				return {
					id: group.provider,
					// Before the catalog lists the provider, its id still finds the brand ("openai-codex" → "ChatGPT").
					name: shortProviderName(info ?? { id: group.provider, name: group.provider }),
					percent: Math.min(100, Math.round(fraction * 100)),
					standing: accountStanding(source),
				};
			}),
		[reports, provider, providers],
	);
	if (chips.length === 0 && !reports?.some(report => report.credits)) return null;
	return (
		<>
			<Button
				aria-expanded={open}
				aria-label={chips.length === 0 ? t("sidebar.pin.usage") : undefined}
				aria-haspopup="dialog"
				className={SEGMENT}
				data-status-usage
				icon={<Gauge />}
				onClick={() => setOpen(!open)}
				ref={anchor}
				size="sm"
				variant="ghost"
			>
				{chips.slice(0, 3).map(chip => (
					<span className="tabular-nums" data-usage-standing={chip.standing} key={chip.id}>
						{chip.name} {chip.percent}%
					</span>
				))}
				{chips.length > 3 && <span>+{chips.length - 3}</span>}
			</Button>
			<Popover
				anchorRef={anchor}
				ariaLabel={t("sidebar.pin.usage")}
				className="omp-status-usage-popover p-2"
				onClose={() => setOpen(false)}
				open={open}
				placement="top-start"
			>
				<SidebarUsage popover />
			</Popover>
		</>
	);
}

/** The paired computers: how many are connected, a dot for the worst link; Settings › Connections on a click. */
function LinkItem() {
	const t = useT();
	const hosts = usePairedHosts();
	if (hosts.length === 0) return null;
	const online = hosts.filter(host => host.state === "online").length;
	const tone = online === hosts.length ? "success" : online === 0 ? "danger" : "warning";
	return (
		<Button
			className={SEGMENT}
			data-status-link={tone}
			icon={<MonitorSmartphone />}
			onClick={() => useUiStore.getState().openSettings("connections:remote")}
			size="sm"
			title={hosts
				.map(host => `${host.name}: ${t(`statusBar.link.${host.state === "online" ? "on" : "off"}`)}`)
				.join("\n")}
			variant="ghost"
		>
			<StatusDot decorative tone={tone} />
			<span className="tabular-nums">{t("statusBar.link.count", { online, total: hosts.length })}</span>
		</Button>
	);
}

/** An app update on its way or ready: its version; Settings › Updates on a click (the sidebar's card acts on it). */
function UpdateItem() {
	const t = useT();
	const status = useUpdaterStore(s => s.status);
	if (status.state !== "available" && status.state !== "downloading" && status.state !== "downloaded") return null;
	return (
		<Button
			className={SEGMENT}
			data-status-update={status.state}
			icon={<ArrowUpCircle />}
			onClick={() => useUiStore.getState().openSettings("updates")}
			size="sm"
			variant="ghost"
		>
			{t(status.state === "downloaded" ? "statusBar.update.ready" : "statusBar.update.coming", {
				version: status.version,
			})}
		</Button>
	);
}

export function StatusBarSegments({ sessionStats }: { sessionStats: boolean }) {
	const t = useT();
	const hidden = useSidebarFolds(s => s.statusHidden);
	const [menu, setMenu] = useState<ContextMenuAnchor | null>(null);
	const openMenu = (event: MouseEvent) => {
		event.preventDefault();
		setMenu(anchorFromEvent(event));
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
		event.preventDefault();
		const rect = event.currentTarget.getBoundingClientRect();
		setMenu({ x: rect.left || 8, y: rect.top || 8 });
	};
	return (
		<div className="flex min-w-0 flex-1 items-center gap-3" onContextMenu={openMenu} onKeyDown={onKeyDown}>
			{hidden.usage !== true && <UsageItem />}
			{sessionStats && hidden.session !== true && <SessionUsage inFooter />}
			<span className="flex-1" />
			{hidden.link !== true && <LinkItem />}
			{hidden.update !== true && <UpdateItem />}
			{menu && (
				<ContextMenu
					ariaLabel={t("statusBar.menu")}
					items={STATUS_ITEMS.filter(item => sessionStats || item !== "session").map(item => ({
						id: `status-${item}`,
						label: t(ITEM_LABEL_KEY[item]),
						checked: hidden[item] !== true,
						onSelect: () => {
							setMenu(null);
							useSidebarFolds.getState().setStatusHidden(item, hidden[item] !== true);
						},
					}))}
					onClose={() => setMenu(null)}
					x={menu.x}
					y={menu.y}
				/>
			)}
		</div>
	);
}
