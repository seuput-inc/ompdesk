import { AlertTriangle, Circle, WifiOff, XCircle } from "lucide-react";
import { useSessionAttention } from "../../hooks/use-session-attention";
import { useFocusedRun } from "../../hooks/use-tab-run";
import { ATTENTION_LABEL_KEY } from "../../lib/attention";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useHostLinkLost, useHostView, useRemoteStore, useTailscaleHint } from "../../stores/remote";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useWebLinkLost } from "../../web/link-status";
import { Badge, Spinner } from "../common";

/**
 * `pending`: the connection is coming up or back (starting, waiting, reconnecting): a still hollow dot, never a spinner.
 * `offline`: the link to the computer (a phone's page) or to the tab's paired host has stayed down past
 * `LINK_NOTICE_GRACE_MS`: the one place a lost link shows, in the bar's own flow, so it never covers a control.
 */
type StatusTone = "ready" | "busy" | "pending" | "offline" | "attention" | "error";

export function StatusIcon({ tone }: { tone: StatusTone }) {
	if (tone === "busy")
		return (
			<span aria-hidden className="inline-flex">
				<Spinner size="sm" spin />
			</span>
		);
	if (tone === "pending")
		return <Circle aria-hidden className="size-2 fill-transparent text-(--sc-text-muted)" strokeWidth={3} />;
	if (tone === "attention") return <AlertTriangle aria-hidden className="size-(--sc-icon-sm) text-(--sc-attention)" />;
	if (tone === "offline") return <WifiOff aria-hidden className="size-(--sc-icon-sm) text-(--sc-warning)" />;
	if (tone === "error") return <XCircle aria-hidden className="size-(--sc-icon-sm) text-(--sc-danger)" />;
	return <Circle aria-hidden className="size-2 fill-current text-(--sc-success)" />;
}

/**
 * The session's state beside its name, spelled like the sidebar row: needs
 * approval and failures are the same warning/danger badges the row shows;
 * working keeps the row's spinner; ready stays quiet (dot + muted word).
 */
export function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
	if (tone === "attention" || tone === "error" || tone === "offline") {
		return (
			<Badge className="omp-titlebar-status-badge gap-1" variant={tone === "error" ? "error" : "warning"}>
				<StatusIcon tone={tone} />
				<span className="omp-titlebar-status-label">{label}</span>
			</Badge>
		);
	}
	return (
		<span
			className={cx(
				"flex items-center gap-1.5 text-sc-sm",
				tone === "busy" ? "text-(--sc-text-secondary)" : "text-(--sc-text-muted)",
			)}
		>
			<StatusIcon tone={tone} />
			<span className="omp-titlebar-status-label">{label}</span>
		</span>
	);
}

export function useSessionStatus() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const attention = useSessionAttention();
	// A remote tab names its host; while the link is down the tab is reconnecting,
	// not failed. A host that is gone from the device list (unpaired) never comes back.
	const device = useTabsStore(s => s.tabs.find(tab => tab.id === (tabId ?? s.activeTabId))?.device);
	const host = useHostView(device);
	const remoteLoaded = useRemoteStore(s => s.state !== null);
	// Unknown before the device list loads: no host is not "removed" and not "reconnecting" yet. The chip is
	// a pending state, not an alarm, so it names a dropped link at once (the pane's banner waits out the grace).
	const unpaired = device !== undefined && remoteLoaded && host === undefined;
	const reconnecting = host !== undefined && host.state !== "online";
	const hostLinkLost = useHostLinkLost(device);
	const tailscaleHint = useTailscaleHint(device);
	const webLinkLost = useWebLinkLost();
	// What the session does, as its summary and its sidebar row say (`sessionRun`). A session that is not up (connecting,
	// restarting, held, failed, exited) outranks what it needs from the person: a question on it cannot be answered
	// there. Before its computer said anything, it reads as ready.
	const { summary, run } = useFocusedRun();
	const hostOffline = !webLinkLost && !unpaired && hostLinkLost && host !== undefined;
	const [tone, statusLabel]: [StatusTone, string] = webLinkLost
		? ["offline", t(webLinkLost === "connecting" ? "web.connection.connecting" : "web.connection.lost")]
		: unpaired
			? ["error", t("remote.tab.statusRemoved")]
			: hostOffline
				? ["offline", t("remote.tab.reconnecting", { name: host.name })]
				: reconnecting
					? ["pending", t("remote.tab.statusReconnecting")]
					: !summary || !run.signal
						? ["ready", t("titlebar.status.ready")]
						: run.down || summary.status === "waiting"
							? [run.failed || summary.status === "exited" ? "error" : "pending", t(run.signal.labelKey)]
							: summary.waitsForDevice
								? ["pending", t("titlebar.status.deviceWait", { device: summary.waitsForDevice })]
								: attention
									? ["attention", t(ATTENTION_LABEL_KEY[attention.kind])]
									: run.running
										? ["busy", t("titlebar.status.working")]
										: ["ready", t(run.signal.labelKey)];
	const title = hostOffline && tailscaleHint ? `${statusLabel} ${t("remote.sidebar.tailscaleHint")}` : statusLabel;
	return { tone, label: statusLabel, title, lostDevice: hostOffline ? device : undefined };
}
