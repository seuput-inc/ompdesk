/**
 * The `voice.dictate` key for the whole window (Orca's hold gesture and insertion target, `use-hold-dictation-gesture.ts`
 * and `dictation-insertion-target.ts`, commit 02cecc98): focus in a composer, or in nothing that takes text, sends the
 * press to the focused tab's composer; focus in another text field, an editable region or a terminal starts a take
 * of its own whose words land there, shown in a pill at the window's bottom (over a terminal, at its bottom edge).
 * A tap starts and stops a take, a press held 300 ms records until release.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDictationTake } from "../../hooks/use-dictation-take";
import { type DictationTarget, dictationTarget, insertDictation } from "../../lib/dictation-target";
import { translate, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { chordFromEvent, compileKeymap, KEYMAP_ACTIONS } from "../../lib/keymap";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { DictationFailureNotice, DictationOverlay } from "../layout/composer/DictationOverlay";
import { DICTATE_EVENT, type DictateDetail } from "../layout/composer/use-composer-dictation";

type FieldTarget = Exclude<DictationTarget, { kind: "composer" }>;

/** The pill's place: centred over a terminal's bottom edge, else the window's bottom centre (Orca's pill anchor). */
function pillBox(target: FieldTarget | null): { left: number; bottom: number; width: number } | null {
	const pane = target?.kind === "terminal" ? target.element.closest<HTMLElement>(".xterm")?.parentElement : null;
	if (!pane?.isConnected) return null;
	const rect = pane.getBoundingClientRect();
	if (rect.width <= 32 || rect.height === 0) return null;
	return {
		left: rect.left + rect.width / 2,
		bottom: window.innerHeight - rect.bottom + 12,
		width: Math.min(440, rect.width - 32),
	};
}

export function DictationHost() {
	const t = useT();
	const sttEnabled = useSettingsStore(state => state.sttEnabled);
	const overrides = useUiStore(state => state.keymapOverrides);
	const keymap = useMemo(() => compileKeymap(KEYMAP_ACTIONS, overrides), [overrides]);
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);
	const [target, setTarget] = useState<FieldTarget | null>(null);
	const targetRef = useRef<FieldTarget | null>(null);
	const deliver = useRef((text: string) => {
		const where = targetRef.current;
		targetRef.current = null;
		setTarget(null);
		if (!where || !text) return;
		if (insertDictation(where, text)) return;
		navigator.clipboard.writeText(text).then(
			() => toast({ variant: "info", message: translate("voice.dictation.toClipboard") }),
			() => {},
		);
	});
	const take = useDictationTake({ deliver, mountedRef });
	const takeRef = useRef(take);
	takeRef.current = take;

	useEffect(() => {
		if (!sttEnabled) return;
		/** The press under way: where it went, and how its release is recognised (the key, or a modifier it held). */
		let press: { route: "composer" | "field"; tabId: string; code: string; modifiers: Set<string> } | null = null;
		const release = () => {
			const ended = press;
			press = null;
			if (!ended) return;
			if (ended.route === "field") takeRef.current.pressUp();
			else
				window.dispatchEvent(
					new CustomEvent<DictateDetail>(DICTATE_EVENT, { detail: { tabId: ended.tabId, press: "up" } }),
				);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			const chord = chordFromEvent(event);
			if (!chord || keymap.get(chord) !== "voice.dictate") return;
			event.preventDefault();
			event.stopPropagation();
			// Key repeat keeps the press; it never starts another take.
			if (event.repeat || press) return;
			const modifiers = new Set(
				[
					event.altKey && "Alt",
					event.ctrlKey && "Control",
					event.metaKey && "Meta",
					event.shiftKey && "Shift",
				].filter((name): name is string => typeof name === "string"),
			);
			// A take of this host's own, under way or transcribing, owns the key until it ends.
			const where = targetRef.current ?? dictationTarget(document.activeElement);
			if (where.kind === "composer") {
				const tabId = useTabsStore.getState().activeTabId;
				if (!tabId) return;
				press = { route: "composer", tabId, code: event.code, modifiers };
				window.dispatchEvent(new CustomEvent<DictateDetail>(DICTATE_EVENT, { detail: { tabId, press: "down" } }));
				return;
			}
			press = { route: "field", tabId: "", code: event.code, modifiers };
			if (!targetRef.current) {
				targetRef.current = where;
				setTarget(where);
			}
			takeRef.current.pressDown();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (!press) return;
			if (event.code === press.code || press.modifiers.has(event.key)) release();
		};
		const onHidden = () => {
			if (document.visibilityState !== "visible") release();
		};
		// Document capture: after the Settings shortcut recorder (window capture), before a terminal or field sees it.
		document.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keyup", onKeyUp, true);
		window.addEventListener("blur", release);
		document.addEventListener("visibilitychange", onHidden);
		return () => {
			release();
			document.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("keyup", onKeyUp, true);
			window.removeEventListener("blur", release);
			document.removeEventListener("visibilitychange", onHidden);
		};
	}, [sttEnabled, keymap]);

	// A take that ended without words (discarded, failed) lets its field go once its notice is dismissed.
	useEffect(() => {
		if (take.phase === "idle" && !take.failure && targetRef.current) {
			targetRef.current = null;
			setTarget(null);
		}
	}, [take.phase, take.failure]);

	if (!target) return null;
	const box = pillBox(target);
	return createPortal(
		<div
			aria-label={t("voice.dictation.target")}
			className="omp-floating omp-pop-in no-drag fixed z-(--sc-z-popover) -translate-x-1/2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) py-1"
			data-dictation-pill={target.kind}
			// Presses on the pill keep focus where the words are going.
			onMouseDown={event => event.preventDefault()}
			role="group"
			style={
				box
					? { left: box.left, bottom: box.bottom, width: box.width }
					: { left: "50%", bottom: 48, width: "min(440px, calc(100vw - 2rem))" }
			}
		>
			{take.phase !== "idle" ? (
				<DictationOverlay
					levels={take.levels}
					phase={take.phase}
					preparing={take.preparing}
					startedAt={take.startedAt}
					words={take.words}
				/>
			) : take.failure ? (
				<DictationFailureNotice failure={take.failure} onDismiss={take.dismissFailure} />
			) : null}
		</div>,
		document.body,
	);
}
