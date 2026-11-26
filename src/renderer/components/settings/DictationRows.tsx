/**
 * Settings › Agent behavior › Dictation, below stock's switch and send rule: the microphone (kept per device; a
 * paired phone keeps its own, `DEVICE_LOCAL_PREF_KEYS`) with a level test (Orca's microphone row and test panel,
 * `VoiceMicrophoneSetting.tsx`, `use-voice-microphone-test.ts`), the terms dictation spells your way, and the opt-in
 * cleanup on a small model. Shown while dictation is on.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { captureContext, METER_BARS, openMicrophone } from "../../lib/dictation-capture";
import { captureMicrophone, listMicrophones, type MicrophoneCapture } from "../../lib/dictation-live";
import { saveGuiPreference } from "../../lib/display-preferences";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { Button, ProgressBar, Select, TextArea } from "../common";
import { SettingsRow, SettingsSwitchRow } from "./SettingsLayout";

/** How long a level test listens before it lets the microphone go (Orca's `MICROPHONE_TEST_MAX_SECONDS`). */
const TEST_MS = 10_000;

function useDictationPref<T>(key: string, parse: (value: unknown) => T, initial: T): [T, (next: T) => void] {
	const [value, setValue] = useState(initial);
	useEffect(() => {
		let live = true;
		window.omp.prefs
			.get(key)
			.then(stored => {
				if (live) setValue(parse(stored));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [key, parse]);
	return [value, next => void saveGuiPreference(key, next, () => setValue(next))];
}

const asString = (value: unknown) => (typeof value === "string" ? value : "");
const asTrue = (value: unknown) => value === true;

export function DictationRows() {
	const t = useT();
	const sttEnabled = useSettingsStore(state => state.sttEnabled);
	const [microphone, setMicrophone] = useDictationPref("dictationMicrophone", asString, "");
	const [storedTerms, setStoredTerms] = useDictationPref("dictationTerms", asString, "");
	const [cleanup, setCleanup] = useDictationPref("dictationCleanup", asTrue, false);
	const [terms, setTerms] = useState<string | null>(null);
	const [inputs, setInputs] = useState<{ deviceId: string; label: string }[]>([]);
	const [level, setLevel] = useState<number | null>(null);
	const test = useRef<{ capture: MicrophoneCapture | null; timer: ReturnType<typeof setTimeout> } | null>(null);
	const termsId = useId();

	const refreshInputs = useCallback(() => {
		listMicrophones()
			.then(setInputs)
			.catch(() => {});
	}, []);
	useEffect(() => {
		if (!sttEnabled) return;
		refreshInputs();
		navigator.mediaDevices?.addEventListener?.("devicechange", refreshInputs);
		return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refreshInputs);
	}, [sttEnabled, refreshInputs]);

	const stopTest = useCallback(() => {
		const running = test.current;
		test.current = null;
		if (!running) return;
		clearTimeout(running.timer);
		running.capture?.close();
		setLevel(null);
	}, []);
	useEffect(() => stopTest, [stopTest]);

	const startTest = () => {
		stopTest();
		const running: NonNullable<typeof test.current> = { capture: null, timer: setTimeout(stopTest, TEST_MS) };
		test.current = running;
		setLevel(0);
		// Made inside the click: WebKit keeps a context made later suspended.
		let context: AudioContext;
		try {
			context = captureContext();
		} catch {
			stopTest();
			return;
		}
		openMicrophone(microphone || undefined)
			.then(stream => {
				if (test.current !== running) {
					for (const track of stream.getTracks()) track.stop();
					void context.close();
					return;
				}
				running.capture = captureMicrophone(
					stream,
					null,
					levels => setLevel(levels.reduce((sum, value) => sum + value, 0) / METER_BARS),
					context,
				);
				// Labels are named once the microphone was allowed.
				refreshInputs();
			})
			.catch(() => {
				void context.close();
				stopTest();
			});
	};

	if (!sttEnabled) return null;
	const options = [
		{ value: "", label: t("settings.dictation.microphoneDefault") },
		...inputs.map((input, index) => ({
			value: input.deviceId,
			label: input.label || t("settings.dictation.microphoneUnnamed", { number: index + 1 }),
		})),
	];
	// A stored microphone that is not plugged in stays chosen: it is used again once it is back.
	if (microphone && !inputs.some(input => input.deviceId === microphone))
		options.push({ value: microphone, label: t("settings.dictation.microphoneUnnamed", { number: options.length }) });
	return (
		<>
			<SettingsRow
				control={
					<div className="flex min-w-0 items-center gap-2">
						<Select
							aria-label={t("settings.dictation.microphone")}
							onChange={event => {
								stopTest();
								setMicrophone(event.target.value);
							}}
							options={options}
							value={microphone}
						/>
						<Button onClick={level === null ? startTest : stopTest} size="sm" variant="secondary">
							{level === null ? t("settings.dictation.test") : t("settings.dictation.testStop")}
						</Button>
					</div>
				}
				description={t("settings.dictation.microphoneDesc")}
				footer={
					level === null ? undefined : (
						<div className="max-w-60 py-1" data-dictation-test-level>
							<ProgressBar
								animate={false}
								ariaLabel={t("settings.dictation.testLevel")}
								valueText=""
								value={level}
							/>
						</div>
					)
				}
				id="setting-gui-dictationMicrophone"
				label={t("settings.dictation.microphone")}
			/>
			<SettingsRow
				description={t("settings.dictation.termsDesc")}
				htmlFor={termsId}
				id="setting-gui-dictationTerms"
				label={t("settings.dictation.terms")}
			>
				<TextArea
					id={termsId}
					mono
					onBlur={() => {
						if (terms !== null && terms !== storedTerms) setStoredTerms(terms);
						setTerms(null);
					}}
					onChange={event => setTerms(event.target.value)}
					placeholder={t("settings.dictation.termsPlaceholder")}
					rows={3}
					spellCheck={false}
					value={terms ?? storedTerms}
				/>
			</SettingsRow>
			<SettingsSwitchRow
				checked={cleanup}
				description={t("settings.dictation.cleanupDesc")}
				id="setting-gui-dictationCleanup"
				label={t("settings.dictation.cleanup")}
				onCheckedChange={setCleanup}
			/>
		</>
	);
}
