/**
 * The Preview's start page (Orca's new-tab page, `browser-pane/new-tab/**`): what an empty tab can open at once.
 * Three short lists, each only when it has something: the dev servers this session's processes listen on (core
 * `procs.ports` through `stores/session-ports.ts`; a linked worktree's open under its own `<name>.localhost`), the
 * SSH forwards that are up on this computer (Settings › SSH), and the sites this computer's Preview visited last
 * (core `browsing.rs`), each with its ✕. Nothing at all leaves the plain "No page open" with Enter URL.
 * A paired host's tab lists its host's servers: each opens through a stand-in on this computer's loopback that the
 * host connects only to the tab's own port (`preview.hostPort`, remote/port-tunnels.ts).
 */
import { Globe, History, Network, Server, X } from "lucide-react";
import { useEffect, useState } from "react";
import { type PreviewHistoryEntry, portAddress } from "../../../shared/preview";
import type { SshForward } from "../../../shared/ssh-tools";
import { hostPortUrl } from "../../lib/host-ports";
import { useT } from "../../lib/i18n";
import { useSessionPorts, useSessionPortsPoll } from "../../stores/session-ports";
import { toastError } from "../../stores/toast";
import { Button, EmptyState, IconButton, LinkButton, ListRow, SectionLabel } from "../common";

/** Recent sites the start page lists. */
const RECENT_SITES = 6;

export function PreviewStart({
	tabId,
	remote,
	worktree,
	onOpen,
	onEnterUrl,
}: {
	tabId: string | null;
	/** The tab runs on a paired host: its servers listen on the host's loopback and open here through the link. */
	remote: boolean;
	/** The tab's linked worktree folder, whose servers open under its own `.localhost` name. */
	worktree: string | null;
	onOpen: (url: string) => void;
	onEnterUrl: () => void;
}) {
	const t = useT();
	useSessionPortsPoll(tabId ? [tabId] : []);
	const processes = useSessionPorts(tabId);
	const servers = processes
		.flatMap(process => process.ports.map(port => ({ port, name: process.name })))
		.sort((a, b) => a.port - b.port);
	const [forwards, setForwards] = useState<SshForward[]>([]);
	const [recent, setRecent] = useState<PreviewHistoryEntry[]>([]);
	useEffect(() => {
		if (remote) return;
		window.omp.sshTools.command({ action: "state" }).then(
			state => setForwards(state.forwards),
			() => undefined,
		);
		return window.omp.sshTools.onState(state => setForwards(state.forwards));
	}, [remote]);
	const readRecent = () =>
		window.omp.preview.history({ action: "list", query: "", limit: RECENT_SITES }).then(setRecent, () => undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read once when the page shows
	useEffect(() => {
		void readRecent();
	}, []);
	const upForwards = forwards.filter(forward => forward.status.kind === "up");
	const remove = (url: string) =>
		void window.omp.preview
			.history({ action: "remove", url })
			.then(readRecent)
			.catch(() => undefined);
	if (servers.length === 0 && upForwards.length === 0 && recent.length === 0)
		return (
			<EmptyState
				icon={<Globe />}
				size="sm"
				title={t("panel.preview.empty")}
				actions={
					<Button size="sm" variant="secondary" onClick={onEnterUrl}>
						{t("panel.preview.enterUrl")}
					</Button>
				}
			/>
		);
	return (
		<div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-3" data-preview-start>
			{servers.length > 0 && (
				<section aria-labelledby="preview-start-servers" data-preview-start-servers>
					<SectionLabel id="preview-start-servers">{t("panel.preview.start.servers")}</SectionLabel>
					<ul className="mt-1">
						{servers.map(({ port, name }) => {
							const url = portAddress(port, worktree);
							return (
								<li key={port}>
									<ListRow
										description={`${remote ? t("panel.preview.start.onHost") : new URL(url).host} · ${name}`}
										leading={<Server aria-hidden className="size-(--sc-icon-sm)" />}
										onClick={() => {
											if (!remote) onOpen(url);
											else if (tabId)
												hostPortUrl(tabId, port).then(onOpen, (error: unknown) =>
													toastError({ title: t("panel.preview.start.remoteFailed"), error }),
												);
										}}
										size="sm"
										title={`:${port}`}
										tooltip={remote ? t("panel.preview.start.remoteServer") : url}
									/>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			{upForwards.length > 0 && (
				<section aria-labelledby="preview-start-forwards" data-preview-start-forwards>
					<SectionLabel id="preview-start-forwards">{t("panel.preview.start.forwards")}</SectionLabel>
					<ul className="mt-1">
						{upForwards.map(forward => {
							const url = portAddress(forward.localPort);
							return (
								<li key={forward.id}>
									<ListRow
										description={t("panel.preview.start.forward", {
											server: forward.server,
											port: forward.remotePort,
										})}
										leading={<Network aria-hidden className="size-(--sc-icon-sm)" />}
										onClick={() => onOpen(url)}
										size="sm"
										title={`:${forward.localPort}`}
										tooltip={url}
									/>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			{recent.length > 0 && (
				<section aria-labelledby="preview-start-recent" data-preview-start-recent>
					<SectionLabel
						action={
							<LinkButton
								onClick={() =>
									void window.omp.preview
										.history({ action: "clear" })
										.then(readRecent)
										.catch(() => undefined)
								}
								tone="muted"
							>
								{t("panel.preview.start.clear")}
							</LinkButton>
						}
						id="preview-start-recent"
					>
						{t("panel.preview.start.recent")}
					</SectionLabel>
					<ul className="mt-1">
						{recent.map(entry => (
							<li key={entry.url}>
								<ListRow
									actions={
										<IconButton
											icon={<X />}
											label={t("panel.preview.start.remove", { title: entry.title || entry.url })}
											onClick={() => remove(entry.url)}
											size="sm"
										/>
									}
									actionCount={1}
									description={entry.url}
									disabled={remote && !entry.url.startsWith("https:")}
									leading={<History aria-hidden className="size-(--sc-icon-sm)" />}
									onClick={() => onOpen(entry.url)}
									size="sm"
									title={entry.title || new URL(entry.url).host}
									tooltip={entry.url}
								/>
							</li>
						))}
					</ul>
				</section>
			)}
			<div>
				<Button size="sm" variant="ghost" onClick={onEnterUrl}>
					{t("panel.preview.enterUrl")}
				</Button>
			</div>
		</div>
	);
}
