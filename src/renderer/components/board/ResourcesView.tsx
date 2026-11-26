/**
 * All sessions › Resources (after Orca's resource usage panel and its sleep action, stablyai/orca
 * `components/status-bar/resources/*`, `sleep/WorkspaceSleepMenuItems.tsx` and `terminal/session-management/*`, MIT;
 * re-implemented; FB100, FS101, FB33): what each live session of this computer holds now, read from one process
 * listing (`SessionProcesses.use`: everything carrying the session's tag, its omp first), the largest first. A
 * session opens to its processes, each with Stop (never its omp, which is the tab's own; ending it is closing the
 * tab), and a quiet tab offers "Give back now", the idle release the memory watch does only while memory is short.
 * Paints its last read at once (`lib/last-read.ts`) and reads again every few seconds while the window shows.
 */
import { MemoryStick, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SessionUse } from "../../../shared/ipc-types";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { lastRead, rememberRead } from "../../lib/last-read";
import { pollWhileVisible } from "../../lib/visible-poll";
import { toast, toastError } from "../../stores/toast";
import { Button, Card, DisclosureButton, EmptyState, IconButton, InlineNotice } from "../common";

const READ_KEY = "board-resources";
/** How often the listing is read again while the page shows. */
const READ_EVERY_MS = 5_000;

export function ResourcesView({ titleOf }: { titleOf: (use: SessionUse) => string }) {
	const t = useT();
	const [use, setUse] = useState<SessionUse[] | null>(() => lastRead<SessionUse[]>(undefined, READ_KEY) ?? null);
	const [failed, setFailed] = useState(false);
	const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
	const read = useCallback(() => {
		window.omp.sessions.use().then(
			next => {
				setFailed(next === null);
				if (!next) return;
				setUse(next);
				rememberRead(undefined, READ_KEY, next);
			},
			() => setFailed(true),
		);
	}, []);
	useEffect(() => {
		read();
		return pollWhileVisible(read, READ_EVERY_MS);
	}, [read]);

	const stop = async (session: SessionUse, pid: number, startedMs: number | undefined) => {
		if (session.ompPid === undefined || startedMs === undefined) return;
		try {
			const ended = await window.omp.sessions.endProcess(session.ompPid, pid, startedMs);
			if (!ended) toast({ variant: "warning", message: t("board.resources.stopFailed") });
			read();
		} catch (error) {
			toastError({ title: t("board.resources.stopFailed"), error });
		}
	};
	const giveBack = async (tabId: string) => {
		try {
			const outcome = await window.omp.sessions.giveBack(tabId);
			toast(
				outcome === "released"
					? { variant: "success", message: t("board.resources.givenBack") }
					: { variant: "warning", message: t("board.resources.busy") },
			);
			read();
		} catch (error) {
			toastError({ title: t("board.resources.giveBackFailed"), error });
		}
	};

	if (!use)
		return failed ? (
			<InlineNotice className="px-6 py-6" title={t("board.resources.unreadable")} tone="warning" />
		) : (
			<EmptyState size="md" title={t("board.resources.reading")} />
		);
	if (use.length === 0) return <EmptyState size="md" title={t("board.resources.none")} />;
	const total = use.reduce((sum, session) => sum + session.bytes, 0);
	return (
		<div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 min-[1280px]:px-10" data-board-resources>
			<p className="pb-2 text-sc-sm text-(--sc-text-secondary)">
				{t("board.resources.total", { size: formatBytes(total), count: use.length })}
			</p>
			<ul className="flex max-w-3xl flex-col gap-2">
				{use.map(session => {
					const key = session.ompPid ?? -1;
					const expanded = open.has(key);
					const title = titleOf(session);
					return (
						<Card
							as="li"
							data-board-resource={session.sessionPath ?? ""}
							key={`${key}:${session.cwd}`}
							padding="none"
						>
							<div className="flex items-center gap-2 px-2.5 py-1.5">
								<DisclosureButton
									className="min-w-0 flex-1"
									onToggle={() =>
										setOpen(current => {
											const next = new Set(current);
											if (next.has(key)) next.delete(key);
											else next.add(key);
											return next;
										})
									}
									open={expanded}
								>
									<span className="min-w-0 truncate text-sc-sm font-medium">{title}</span>
								</DisclosureButton>
								<span className="shrink-0 text-sc-xs text-(--sc-text-muted) tabular-nums">
									{t("board.resources.processes", { count: session.processes.length })} ·{" "}
									{formatBytes(session.bytes)}
								</span>
								{session.tabId && session.quiet && (
									<Button
										data-board-give-back
										icon={<MemoryStick />}
										onClick={() => void giveBack(session.tabId as string)}
										size="sm"
										variant="secondary"
									>
										{t("board.resources.giveBack")}
									</Button>
								)}
							</div>
							{expanded && (
								<ul className="border-t border-(--sc-border-subtle) px-2.5 py-1">
									{session.processes.map(process => (
										<li
											className="flex items-center gap-2 py-0.5 text-sc-xs text-(--sc-text-secondary)"
											data-board-process={process.pid}
											key={process.pid}
										>
											<span className="min-w-0 flex-1 truncate font-mono">
												{process.omp ? t("board.resources.omp", { name: process.name }) : process.name}
											</span>
											<span className="shrink-0 tabular-nums text-(--sc-text-muted)">
												{process.pid} · {formatBytes(process.bytes)}
											</span>
											{!process.omp && process.startedMs !== undefined && (
												<IconButton
													icon={<Square />}
													label={t("board.resources.stop", { name: process.name })}
													onClick={() => void stop(session, process.pid, process.startedMs)}
													size="sm"
												/>
											)}
										</li>
									))}
								</ul>
							)}
						</Card>
					);
				})}
			</ul>
		</div>
	);
}
