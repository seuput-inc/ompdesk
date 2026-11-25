import { CheckCircle2, XCircle } from "lucide-react";
import { ciTarget, parseCiResult } from "../../../../resources/gui-bridge/modes/ci-watch-contracts";
import type { AgentMessage } from "../../../shared/rpc-types";
import { resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { LinkButton } from "../common/LinkButton";

/**
 * The CI result of a commit this session pushed (bridge custom message `ompdesk-ci`,
 * resources/gui-bridge/modes/ci-watch-contracts.ts): one muted line between turns, with the run to open. The model
 * reads the message's own text with the next turn.
 */
export function CiNote({ message }: { message: AgentMessage }) {
	const t = useT();
	const result = parseCiResult(resultDetails(message));
	if (!result) return null;
	const passed = result.outcome === "success";
	const Icon = passed ? CheckCircle2 : XCircle;
	const failed = !passed && result.failed.length > 0 ? ` · ${result.failed.join(", ")}` : "";
	const { url } = result;
	return (
		<div
			className="omp-ci-note flex items-start gap-2 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5 text-sc-sm text-(--sc-text-subtle)"
			data-ci-note={result.outcome}
		>
			<Icon
				aria-hidden
				className={`mt-0.5 size-(--sc-icon-sm) shrink-0 ${passed ? "text-(--sc-success)" : "text-(--sc-danger)"}`}
			/>
			<span className="min-w-0 break-words">
				{t(passed ? "chat.ci.passed" : "chat.ci.failed")} · {ciTarget(result)}
				{failed}
				{url ? (
					<>
						{" · "}
						<LinkButton onClick={() => openExternal(url)} tone="muted">
							{t("chat.ci.openRun")}
						</LinkButton>
					</>
				) : null}
			</span>
		</div>
	);
}
