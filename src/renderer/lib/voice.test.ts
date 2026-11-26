import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	decodeBase64,
	FakeAudioContext,
	type FakeMic,
	FakeStream,
	installFakeMic,
	SPECTRUM_LEVEL,
	uninstallFakeMic,
} from "../test-support/dictation";
import { resamplerTo16k } from "./dictation-live";
import { translate } from "./i18n";
import {
	cancelVoiceRecording,
	classifyTranscribeError,
	METER_BARS,
	recordAndTranscribe,
	retryTranscription,
	SILENCE_STOP_MS,
	STOP_TAIL_MS,
	stopVoiceRecording,
} from "./voice";

interface RpcReply {
	success: boolean;
	data?: unknown;
	error?: string;
}

type Rpc = Record<string, Mock>;

let mic: FakeMic;
let rpc: Rpc;

/** Resolve pending promise callbacks (capture starts after `getUserMedia` resolves). */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

/** A tenth of a second of sound at 16 kHz. */
const SOUND = () => new Float32Array(1600).fill(0.5);

function stream(words: { text?: string; partial?: string; quietMs?: number } = {}) {
	return vi.fn(
		async (): Promise<RpcReply> => ({
			success: true,
			data: { text: words.text ?? "", partial: words.partial ?? "", quietMs: words.quietMs ?? 0 },
		}),
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	mic = installFakeMic();
	rpc = {
		transcribeAudio: vi.fn(async () => ({ success: true, data: { text: "hello there" } })),
		sttStreamStart: vi.fn(async () => ({ success: true, data: { streamId: "s1" } })),
		sttStreamAudio: stream(),
		sttStreamStop: vi.fn(async () => ({ success: true, data: { text: "Hello there.", language: "en" } })),
		sttStreamCancel: vi.fn(async () => ({ success: true, data: {} })),
	};
	vi.stubGlobal("window", { omp: { rpc } });
});

afterEach(() => {
	// A failed test must not leave the module's single recording slot taken.
	cancelVoiceRecording();
	vi.useRealTimers();
	uninstallFakeMic();
});

describe("a live take", () => {
	it("streams 16 kHz PCM16 as it is heard, shows the words, and ends on stock's transcript after the stop tail", async () => {
		rpc.sttStreamAudio = stream({ text: "Hello", partial: "there" });
		const phases: string[] = [];
		const levels: (readonly number[])[] = [];
		const words: unknown[] = [];
		const take = recordAndTranscribe({
			onRecording: () => phases.push("recording"),
			onLevels: next => levels.push(next),
			onWords: next => words.push(next),
			onTranscribing: () => phases.push("transcribing"),
		});
		await flush();
		expect(mic.getUserMedia).toHaveBeenCalledWith({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
		expect(phases).toEqual(["recording"]);
		// The capture context asked for 16 kHz, so nothing is resampled.
		expect(mic.context().sampleRate).toBe(16_000);
		mic.context().feed(SOUND());

		await vi.advanceTimersByTimeAsync(250);
		expect(rpc.sttStreamAudio).toHaveBeenCalledTimes(1);
		const [id, audio] = rpc.sttStreamAudio.mock.calls[0] as [string, string];
		expect(id).toBe("s1");
		const pcm = decodeBase64(audio);
		expect(pcm.byteLength).toBe(1600 * 2);
		expect(pcm.getInt16(0, true)).toBe(Math.round(0.5 * 32_767));
		expect(words).toEqual([{ text: "Hello", partial: "there" }]);
		expect(levels.at(-1)).toHaveLength(METER_BARS);
		expect(levels.at(-1)?.every(level => level === SPECTRUM_LEVEL / 200)).toBe(true);

		stopVoiceRecording();
		// The tail: what is heard right after the stop still reaches the stream.
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS - 1);
		mic.context().feed(SOUND());
		expect(phases).toEqual(["recording"]);
		await vi.advanceTimersByTimeAsync(1);
		await expect(take).resolves.toEqual({ text: "Hello there.", language: "en" });
		expect(phases).toEqual(["recording", "transcribing"]);
		expect(rpc.sttStreamAudio).toHaveBeenCalledTimes(2);
		expect(rpc.sttStreamStop).toHaveBeenCalledWith("s1");
		expect(rpc.transcribeAudio).not.toHaveBeenCalled();
		expect(mic.streams[0]?.track.stopped).toBe(true);
		expect(FakeAudioContext.instances.every(context => context.closed)).toBe(true);
	});

	it("ends by itself after a minute nobody spoke, unless a held key or button is recording", async () => {
		let holding = true;
		rpc.sttStreamAudio = stream({ quietMs: SILENCE_STOP_MS });
		const take = recordAndTranscribe({ isHolding: () => holding });
		await flush();
		mic.context().feed(SOUND());
		await vi.advanceTimersByTimeAsync(250);
		expect(rpc.sttStreamStop).not.toHaveBeenCalled();
		holding = false;
		mic.context().feed(SOUND());
		await vi.advanceTimersByTimeAsync(250);
		await expect(take).resolves.toEqual({ text: "Hello there.", language: "en", endedBy: "silence" });
	});

	it("is transcribed whole when the language's model is not here yet (no stream), and sends no audio meanwhile", async () => {
		rpc.sttStreamStart = vi.fn(async () => ({ success: true, data: { streamId: null } }));
		const take = recordAndTranscribe();
		await flush();
		mic.context().feed(SOUND());
		await vi.advanceTimersByTimeAsync(250);
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(take).resolves.toEqual({ text: "hello there" });
		expect(rpc.sttStreamAudio).not.toHaveBeenCalled();
		const [wav, mimeType] = rpc.transcribeAudio.mock.calls[0] as [string, string];
		expect(mimeType).toBe("audio/wav");
		const view = decodeBase64(wav);
		expect(view.byteLength).toBe(44 + 1600 * 2);
		expect(view.getUint32(24, true)).toBe(16_000);
	});

	it("falls back to the whole take when the stream fails mid-take, and from an omp without the stream", async () => {
		rpc.sttStreamAudio = vi.fn(async () => ({ success: false, error: "No dictation stream s1" }));
		const take = recordAndTranscribe();
		await flush();
		mic.context().feed(SOUND());
		await vi.advanceTimersByTimeAsync(250);
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(take).resolves.toEqual({ text: "hello there" });
		expect(rpc.sttStreamCancel).toHaveBeenCalledWith("s1");

		rpc.sttStreamStart = vi.fn(async () => ({ success: false, error: "Unknown bridge method" }));
		const older = recordAndTranscribe();
		await flush();
		mic.context().feed(SOUND());
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(older).resolves.toEqual({ text: "hello there" });
	});

	it("keeps a failed take for Retry, which transcribes it whole", async () => {
		rpc.sttStreamStop = vi.fn(async () => ({ success: false, error: "Transcription did not finish within 61 s" }));
		const take = recordAndTranscribe();
		await flush();
		mic.context().feed(SOUND());
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		const result = await take;
		expect(result).toMatchObject({ error: "Transcription did not finish within 61 s", failure: "failed" });
		const kept = "kept" in result ? result.kept : undefined;
		expect(kept?.samples).toBe(1600);
		if (!kept) throw new Error("no kept take");
		await expect(retryTranscription(kept)).resolves.toEqual({ text: "hello there" });
		expect(decodeBase64(rpc.transcribeAudio.mock.calls[0]?.[0] as string).byteLength).toBe(44 + 1600 * 2);
	});
});

describe("a take's edges", () => {
	it("discards a take cancelled while recording, without transcribing, and drops its stream", async () => {
		const onTranscribing = vi.fn();
		const take = recordAndTranscribe({ onTranscribing });
		await flush();
		mic.context().feed(SOUND());
		cancelVoiceRecording();
		await expect(take).resolves.toEqual({ error: "" });
		expect(onTranscribing).not.toHaveBeenCalled();
		expect(rpc.transcribeAudio).not.toHaveBeenCalled();
		expect(rpc.sttStreamStop).not.toHaveBeenCalled();
		expect(rpc.sttStreamCancel).toHaveBeenCalledWith("s1");
		expect(mic.streams[0]?.track.stopped).toBe(true);
	});
	it("ends a take whose held press was released while the microphone still opened, once it has", async () => {
		const opened = Promise.withResolvers<FakeStream>();
		mic.getUserMedia.mockImplementationOnce(() => opened.promise);
		const take = recordAndTranscribe();
		stopVoiceRecording();
		opened.resolve(new FakeStream());
		await flush();
		mic.context().feed(SOUND());
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(take).resolves.toMatchObject({ text: "Hello there." });
	});

	it("discards a take cancelled while the mic still opens and releases the mic once it has", async () => {
		const opened = Promise.withResolvers<FakeStream>();
		mic.getUserMedia.mockImplementationOnce(() => opened.promise);
		const onRecording = vi.fn();
		const take = recordAndTranscribe({ onRecording });
		cancelVoiceRecording();
		const opening = new FakeStream();
		opened.resolve(opening);
		await expect(take).resolves.toEqual({ error: "" });
		expect(onRecording).not.toHaveBeenCalled();
		expect(opening.track.stopped).toBe(true);
	});

	it("refuses a second take while one is opening or recording", async () => {
		const first = recordAndTranscribe();
		await expect(recordAndTranscribe()).resolves.toEqual({ error: translate("voice.mic.busy"), failure: "busy" });
		await flush();
		await expect(recordAndTranscribe()).resolves.toEqual({ error: translate("voice.mic.busy"), failure: "busy" });
		mic.context().feed(SOUND());
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(first).resolves.toMatchObject({ text: "Hello there." });
	});

	it("reports an empty take instead of transcribing silence nobody captured", async () => {
		const take = recordAndTranscribe();
		await flush();
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		await expect(take).resolves.toEqual({ error: translate("voice.mic.empty"), failure: "empty" });
		expect(rpc.transcribeAudio).not.toHaveBeenCalled();
	});

	it("opens the microphone this device chose, falling back to the default when it is gone", async () => {
		vi.stubGlobal("window", { omp: { rpc, prefs: { get: vi.fn(async () => "usb-mic") } } });
		const take = recordAndTranscribe();
		await flush();
		expect(mic.getUserMedia).toHaveBeenCalledWith({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, deviceId: { ideal: "usb-mic" } },
		});
		cancelVoiceRecording();
		await take;
	});

	it("says how far the language's speech model got while a whole take waits for its download", async () => {
		rpc.sttStreamStart = vi.fn(async () => ({ success: true, data: { streamId: null } }));
		const transcribed = Promise.withResolvers<RpcReply>();
		rpc.transcribeAudio.mockImplementationOnce(() => transcribed.promise);
		const answers = [10, 55].map(percent => ({
			success: true,
			data: { language: "ko", modelKey: "whisper-large-v3-turbo", state: "downloading", percent },
		}));
		rpc.sttPrepare = vi.fn(async () => answers.shift() ?? { success: true, data: { state: "ready" } });
		const onPreparing = vi.fn();
		const take = recordAndTranscribe({ onPreparing });
		await flush();
		mic.context().feed(SOUND());
		stopVoiceRecording();
		await vi.advanceTimersByTimeAsync(STOP_TAIL_MS);
		// The prepare loop loads on the take's first wait.
		await vi.waitFor(() => expect(onPreparing.mock.calls).toEqual([[{ language: "ko", percent: 10 }]]));
		await vi.advanceTimersByTimeAsync(500);
		expect(onPreparing.mock.calls.at(-1)).toEqual([{ language: "ko", percent: 55 }]);
		await vi.advanceTimersByTimeAsync(500);
		expect(onPreparing.mock.calls.at(-1)).toEqual([null]);
		transcribed.resolve({ success: true, data: { text: "안녕하세요", language: "ko" } });
		await expect(take).resolves.toEqual({ text: "안녕하세요", language: "ko" });
	});

	it("tells a blocked mic, a missing one and a busy one apart by the rejection's name", async () => {
		for (const [name, failure] of [
			["NotAllowedError", "denied"],
			["NotFoundError", "no-device"],
			["NotReadableError", "in-use"],
		] as const) {
			mic.getUserMedia.mockImplementationOnce(async () => {
				throw new DOMException("x", name);
			});
			await expect(recordAndTranscribe()).resolves.toEqual({ error: "x", failure });
		}
	});

	it("fails a take in a browser without Web Audio, and the next press tries again", async () => {
		vi.stubGlobal("AudioContext", undefined);
		for (let press = 0; press < 2; press++)
			await expect(recordAndTranscribe()).resolves.toMatchObject({ failure: "failed" });
		expect(mic.getUserMedia).not.toHaveBeenCalled();
	});

	it("names a missing dictation model, and nothing else, as no-model", () => {
		expect(classifyTranscribeError("No dictation model configured")).toBe("no-model");
		expect(classifyTranscribeError("Dictation role is not set")).toBe("no-model");
		expect(classifyTranscribeError("No stt model devices configured")).toBe("no-model");
		expect(classifyTranscribeError("Unknown stt model: whisper-x")).toBe("no-model");
		expect(classifyTranscribeError("stt unavailable")).toBe("failed");
		expect(classifyTranscribeError("Fixture bridge does not implement transcribe_audio")).toBe("failed");
	});
});

describe("resampling a context that would not open at 16 kHz", () => {
	it("keeps the time across callbacks: 48 kHz in blocks of any size gives a third as many samples", () => {
		const resample = resamplerTo16k(48_000);
		const out = [4096, 4096, 1000, 3].map(size => resample(new Float32Array(size).fill(0.25)).length);
		expect(out.reduce((sum, count) => sum + count, 0)).toBe(Math.ceil((4096 * 2 + 1003) / 3));
		expect(resample(new Float32Array(3).fill(0.25))[0]).toBe(0.25);
	});
});
