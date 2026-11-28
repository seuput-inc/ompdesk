import { useState } from "react";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { toastError } from "../../stores/toast";
import { Button } from "./Button";

export function KeyQueryFailure({
	provider,
	account,
	fetchedAt,
	lastModels,
	lastConfirmedAt,
	disabled,
}: {
	provider: string;
	account: string;
	fetchedAt?: number;
	lastModels?: readonly string[];
	lastConfirmedAt?: number;
	disabled: boolean;
}) {
	const t = useT();
	const refresh = useModelStore(state => state.refreshProviders);
	const [busy, setBusy] = useState(false);
	const retry = async () => {
		setBusy(true);
		try {
			await refresh(false, provider);
		} catch (error) {
			toastError({ title: t("providers.keyModelsUnavailable"), error });
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-wrap items-center gap-x-2 text-sc-sm" data-key-query-failed={provider}>
			<span role="status">
				{fetchedAt === undefined
					? t("providers.keyModelsUnavailable")
					: t("providers.keyModelQueryFailed", { time: formatClock(fetchedAt) })}
			</span>
			{lastModels && (
				<div className="w-full break-words">
					{t(lastModels.length ? "providers.keyModelsLastSeen" : "providers.keyModelsLastEmpty", {
						time: formatClock(lastConfirmedAt),
					})}
					{lastModels.length > 0 && (
						<ul className="max-h-32 overflow-auto">
							{lastModels.map(id => (
								<li key={id}>{id}</li>
							))}
						</ul>
					)}
				</div>
			)}
			<Button
				aria-label={t("providers.retryKeyModels", { account })}
				disabled={disabled || busy}
				onClick={() => void retry()}
				size="sm"
				variant="ghost"
			>
				{t("common.retry")}
			</Button>
		</div>
	);
}
