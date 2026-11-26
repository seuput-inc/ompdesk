import { useState } from "react";
import type { DictationFailureView } from "../../../hooks/use-dictation-take";
import { languageName } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useNowTick } from "../../../lib/now-tick";
import type { DictationWords, SpeechModelDownload } from "../../../lib/voice";
import { useUiStore } from "../../../stores/ui";
import { Button, InlineNotice, Kbd, ProgressBar } from "../../common";

export type DictationPhase = "idle" | "starting" | "recording" | "transcribing";

/** The words shown while speaking: the newest, since the bar is one line. */
const WORDS_SHOWN = 90;

/**
 * A slim bar between the field and the toolbar while dictating: "Starting microphone…" until the mic opens, then a
 * live level meter with the take's m:ss, the words heard so far (stock's committed segments, then the one being
 * spoken, muted) and the keys that end it (Enter inserts, Esc discards), then "Transcribing…", or, while the take waits
 * for its language's speech model to download, that language and how far the download got. It never covers the field:
 * the draft stays readable and editable, and the transcript lands at its caret.
 */
export function DictationOverlay({
	phase,
	levels,
	startedAt,
	preparing,
	words = null,
}: {
	phase: Exclude<DictationPhase, "idle">;
	levels: readonly number[];
	startedAt: number | null;
	preparing: SpeechModelDownload | null;
	words?: DictationWords | null;
}) {
	const heard = [words?.text, words?.partial].filter(Boolean).join(" ");
	const shown = heard.length > WORDS_SHOWN ? `…${heard.slice(-WORDS_SHOWN)}` : heard;
	const committed = Math.max(0, shown.length - (words?.partial.length ?? 0));
	const t = useT();
	const language = languageName(preparing?.language ?? null);
	const preparingLabel = language ? t("voice.dictation.preparing", { language }) : t("voice.dictation.preparingAny");
	const now = useNowTick(phase === "recording");
	const seconds = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000));
	const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	return (
		<div
			className="omp-dictation flex min-h-7 items-center gap-3 px-4 pb-1 text-sc-sm text-(--sc-text-secondary)"
			data-dictation={phase}
			role="status"
		>
			{phase === "recording" ? (
				<>
					<span aria-hidden className="flex h-5 items-center gap-0.5">
						{levels.map((level, index) => (
							// A bar is the full 20 px lane scaled about its center: a level arrives every frame, so no transition and no layout.
							<span
								className="h-5 w-1 rounded-full bg-(--sc-danger)"
								key={index}
								style={{ transform: `scaleY(${(4 + level * 16) / 20})` }}
							/>
						))}
					</span>
					<span className="tabular-nums text-(--sc-text)">
						{t("voice.dictation.listening")} · {clock}
					</span>
					{shown && (
						// The words change several times a second: kept out of the status region's announcements.
						<span aria-hidden className="min-w-0 flex-1 truncate text-(--sc-text)" data-dictation-words>
							{shown.slice(0, committed)}
							<span className="text-(--sc-text-muted)">{shown.slice(committed)}</span>
						</span>
					)}
					<span className="ms-auto flex shrink-0 items-center gap-1.5 text-sc-xs text-(--sc-text-muted)">
						<Kbd shortcut="Enter" />
						{t("voice.dictation.insert")}
						<Kbd shortcut="Esc" />
						{t("voice.dictation.discard")}
					</span>
				</>
			) : phase === "transcribing" && preparing ? (
				<>
					<span className="min-w-0 shrink-[2] truncate text-(--sc-text)">{preparingLabel}</span>
					<span className="min-w-16 max-w-60 flex-1" data-dictation-download={preparing.percent}>
						<ProgressBar ariaLabel={preparingLabel} tone="progress" value={preparing.percent / 100} />
					</span>
				</>
			) : (
				<span className="omp-pulse-dot">
					{t(phase === "starting" ? "voice.dictation.starting" : "voice.dictation.transcribing")}
				</span>
			)}
		</div>
	);
}

/**
 * A take that failed: one sentence saying what to do (the browser's or the sidecar's text is only the details
 * behind a toggle), plus Settings where Settings is the fix. The OS's own microphone privacy page cannot be opened
 * from here (the host opens web links and mail drafts only), so a blocked microphone says where to go.
 */
export function DictationFailureNotice({
	failure,
	onDismiss,
}: {
	failure: DictationFailureView;
	onDismiss: () => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const hasDetail = failure.kind !== "busy" && failure.kind !== "empty" && failure.detail !== "";
	return (
		<div className="px-3 pb-1" data-dictation-failure={failure.kind}>
			<InlineNotice
				action={
					<>
						{failure.retry && failure.kind !== "no-model" && (
							<Button data-dictation-retry onClick={failure.retry} size="sm" variant="secondary">
								{t("voice.fail.retry")}
							</Button>
						)}
						{failure.kind === "no-model" && (
							<Button
								onClick={() => {
									onDismiss();
									useUiStore.getState().openSettings("models:roles");
								}}
								size="sm"
								variant="secondary"
							>
								{t("voice.fail.openSettings")}
							</Button>
						)}
						{hasDetail && (
							<Button aria-expanded={open} onClick={() => setOpen(value => !value)} size="sm" variant="ghost">
								{t("voice.fail.details")}
							</Button>
						)}
						<Button onClick={onDismiss} size="sm" variant="ghost">
							{t("voice.fail.dismiss")}
						</Button>
					</>
				}
				className="py-1"
				detail={open && hasDetail ? failure.detail : undefined}
				live
				title={t(FAILURE_MESSAGE[failure.kind])}
				tone="danger"
			/>
		</div>
	);
}

const FAILURE_MESSAGE = {
	denied: "voice.fail.denied",
	"no-device": "voice.fail.noDevice",
	"in-use": "voice.fail.inUse",
	busy: "voice.mic.busy",
	empty: "voice.mic.empty",
	"no-model": "voice.fail.noModel",
	failed: "voice.fail.failed",
} as const;
