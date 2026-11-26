/** A run's captured output, read when it opens and again once a run that was still writing it ends. */
import { useEffect, useState } from "react";
import type { ScheduleRun } from "../../../../shared/schedules";
import { AnsiText } from "../../../lib/ansi";
import { useT } from "../../../lib/i18n";
import { ErrorDetail } from "../../common";

export function RunLog({ run, device }: { run: ScheduleRun; device: string | undefined }) {
	const t = useT();
	const [log, setLog] = useState<{ text: string } | { error: unknown } | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a status change re-reads the finished log.
	useEffect(() => {
		let cancelled = false;
		setLog(null);
		window.omp.schedules.readLog(run.id, device).then(
			text => !cancelled && setLog({ text }),
			error => !cancelled && setLog({ error }),
		);
		return () => {
			cancelled = true;
		};
	}, [run.id, run.status, device]);
	return (
		<div
			className="mb-2 max-h-80 overflow-auto rounded-(--sc-radius-md) bg-(--sc-surface-2) p-2 font-mono text-sc-xs whitespace-pre-wrap"
			data-schedule-log
		>
			{log === null ? (
				<span className="text-(--sc-text-muted)">{t("schedules.logLoading")}</span>
			) : "error" in log ? (
				<ErrorDetail error={log.error} />
			) : log.text ? (
				<AnsiText text={log.text} />
			) : (
				<span className="text-(--sc-text-muted)">{t("schedules.logEmpty")}</span>
			)}
		</div>
	);
}
