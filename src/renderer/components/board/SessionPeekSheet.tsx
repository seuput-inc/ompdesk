/**
 * A board card's peek (after Orca's agent preview dialog, stablyai/orca
 * `components/dashboard/terminal-preview/AgentTerminalDialog.tsx:122-180`, and its inline send,
 * `rows/DashboardAgentRowTrailingControls.tsx:80-103`, MIT; re-implemented): what the session did, read from its
 * journal on the computer that runs it (`useStoredTranscript`, read again whenever its run changes), and, for a tab of
 * this window, a line to write to it without leaving the board. A message goes as the composer's own does when its link
 * is up (stock `prompt`, `streamingBehavior: "steer"`: read at once while idle, at the next step while it works).
 * The live step stream of a session reaches only the window that shows it, so the peek reads the journal instead of
 * drawing `LiveStepPeek`.
 */
import { ExternalLink, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import type { TitleParts } from "../../lib/session-title";
import type { MessagesStore } from "../../stores/messages";
import { sessionRuntimeStore } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { Button, Input, PanelErrorBoundary, Sheet } from "../common";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import { useStoredTranscript } from "../panels/use-stored-transcript";
import type { BoardCard } from "./board-cards";

export function SessionPeekSheet({
	card,
	title,
	onOpen,
	onClose,
}: {
	card: BoardCard;
	title: TitleParts;
	onOpen: (card: BoardCard) => void;
	onClose: () => void;
}) {
	const t = useT();
	const phone = useShellMode() === "phone";
	const [draft, setDraft] = useState("");
	const [sending, setSending] = useState(false);
	const transcript = useStoredTranscript(card.sessionPath, card.device, `${card.run.signal?.labelKey}:${card.at}`);
	const tab = card.tab;
	const send = async (event: FormEvent) => {
		event.preventDefault();
		const message = draft.trim();
		if (!tab || !message || sending) return;
		setSending(true);
		try {
			// The computer's echo of this message is this window's own, not "from another device".
			sessionRuntimeStore<MessagesStore>(tab.id, "messages")?.getState().noteOwnSend(message);
			const response = await window.omp.rpc.commandForTab(tab.id, {
				type: "prompt",
				message,
				streamingBehavior: "steer",
			});
			if (!response.success) throw new Error(response.error ?? t("board.peek.sendFailed"));
			setDraft("");
			toast({ variant: "success", message: t("board.peek.sent") });
			transcript.reload();
		} catch (error) {
			toastError({ title: t("board.peek.sendFailed"), error });
		} finally {
			setSending(false);
		}
	};
	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col"
			footer={
				<div className="flex w-full flex-col gap-2">
					{tab ? (
						<form className="flex items-end gap-2" onSubmit={event => void send(event)}>
							<Input
								aria-label={t("board.peek.placeholder")}
								className="min-w-0 flex-1"
								data-board-send
								onChange={event => setDraft(event.target.value)}
								placeholder={t("board.peek.placeholder")}
								value={draft}
							/>
							<Button disabled={!draft.trim()} icon={<Send />} loading={sending} type="submit" variant="primary">
								{t("board.peek.send")}
							</Button>
						</form>
					) : (
						<p className="text-sc-xs text-(--sc-text-muted)">{t("board.peek.openToSend")}</p>
					)}
					<Button
						className="self-start"
						data-board-open
						icon={<ExternalLink />}
						onClick={() => onOpen(card)}
						variant="secondary"
					>
						{t("board.card.open")}
					</Button>
				</div>
			}
			onClose={onClose}
			open
			placement={phone ? "full" : "right"}
			size="lg"
			title={title.title}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-board-peek-sheet={card.sessionPath}>
				<PanelErrorBoundary>
					<SubagentTranscript live={false} transcript={transcript} />
				</PanelErrorBoundary>
			</div>
		</Sheet>
	);
}
