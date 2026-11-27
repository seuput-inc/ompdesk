/**
 * Hand a session to a bot (Orca's `hand-to-bot/HandToBotFlow.tsx:250-343`, FK-B43): the bot's home chat becomes the
 * session's opener (it works for the bot now, nested under it) and gets what to do with it as a message. "New bot…"
 * makes one for it first, the hand-over its first message. A paused bot, or one with no home chat yet, cannot take it.
 */
import { Plus } from "lucide-react";
import { useId, useState } from "react";
import { useT } from "../../lib/i18n";
import { useBotsStore } from "../../stores/bots";
import { Button, Modal, Radio, TextArea } from "../common";
import { BotAvatar } from "./BotAvatar";
import { openBotDialog } from "./bot-launch";

const NEW = "new";

export function HandToBotDialog({ tabId, title, onClose }: { tabId: string; title: string; onClose: () => void }) {
	const t = useT();
	const formId = useId();
	// This computer's bots only: handing a session to another computer's bot (R91) waits for cross-device handoff.
	const bots = useBotsStore(s => s.state.bots).filter(bot => !bot.device);
	const command = useBotsStore(s => s.command);
	const ready = bots.filter(bot => !bot.paused && bot.home);
	const [picked, setPicked] = useState<string>(ready[0]?.id ?? NEW);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const message = text.trim() || t("bots.hand.defaultText", { title });

	const submit = async () => {
		if (busy) return;
		if (picked === NEW) {
			openBotDialog({ kind: "new", draft: { handOver: { tabId, title, text: message } } });
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await command({ action: "handTo", id: picked, session: tabId, text: message });
			onClose();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button form={formId} loading={busy} type="submit" variant="primary">
						{picked === NEW ? t("bots.hand.newBot") : t("bots.hand.submit")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("bots.hand.title", { title })}
		>
			<form
				className="flex flex-col gap-3"
				data-hand-to-bot
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<p className="text-sc-sm text-(--sc-text-muted)">{t("bots.hand.description")}</p>
				<fieldset className="flex flex-col gap-1.5">
					<legend className="sr-only">{t("destination.bots")}</legend>
					<label className="flex items-center gap-2">
						<Radio checked={picked === NEW} name={`${formId}-bot`} onChange={() => setPicked(NEW)} />
						<span className="inline-flex size-8 items-center justify-center rounded-(--sc-radius-md) border border-dashed border-(--sc-border)">
							<Plus aria-hidden className="size-4" />
						</span>
						<span className="flex min-w-0 flex-col">
							<span className="text-sc-sm text-(--sc-text)">{t("bots.hand.new")}</span>
							<span className="text-sc-xs text-(--sc-text-muted)">{t("bots.hand.newHint")}</span>
						</span>
					</label>
					{bots.map(bot => {
						const reason = bot.paused ? t("bots.row.paused") : !bot.home ? t("bots.hand.noHome") : null;
						return (
							<label
								className={reason ? "flex items-center gap-2 opacity-60" : "flex items-center gap-2"}
								key={bot.id}
							>
								<Radio
									checked={picked === bot.id}
									disabled={reason !== null}
									name={`${formId}-bot`}
									onChange={() => setPicked(bot.id)}
								/>
								<BotAvatar bot={bot} size={32} />
								<span className="flex min-w-0 flex-col">
									<span className="text-sc-sm text-(--sc-text)">{bot.name}</span>
									<span className="truncate text-sc-xs text-(--sc-text-muted)">
										{reason ?? bot.specialty ?? ""}
									</span>
								</span>
							</label>
						);
					})}
				</fieldset>
				<TextArea
					autoGrow
					label={t("bots.hand.what")}
					onChange={event => setText(event.target.value)}
					placeholder={t("bots.hand.whatPlaceholder")}
					rows={2}
					value={text}
				/>
				{error && (
					<p className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</p>
				)}
			</form>
		</Modal>
	);
}
