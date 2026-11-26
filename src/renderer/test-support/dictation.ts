/**
 * A fake microphone for dictation tests: `getUserMedia` hands out a stream whose track records being released, the
 * audio context's capture node hands the samples a test feeds it (`FakeAudioContext.feed`) to the page, and the
 * analyser reports a fixed spectrum. `install()` stubs the globals; the test stubs `window.omp.rpc` itself.
 */
import { type Mock, vi } from "vitest";

/** A mic track that records whether it was released. */
export class FakeTrack {
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

export class FakeStream {
	readonly track = new FakeTrack();
	getTracks(): FakeTrack[] {
		return [this.track];
	}
}

/** Every byte of the analyser's spectrum, so the meter's bars are predictable. */
export const SPECTRUM_LEVEL = 100;

interface FakeProcessor {
	onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null;
}

const node = () => ({ connect: () => undefined, disconnect: () => undefined });

export class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	readonly sampleRate: number;
	readonly destination = {};
	closed = false;
	processor: FakeProcessor | null = null;
	constructor(options?: { sampleRate?: number }) {
		this.sampleRate = options?.sampleRate ?? 48_000;
		FakeAudioContext.instances.push(this);
	}
	createAnalyser() {
		return {
			...node(),
			fftSize: 0,
			smoothingTimeConstant: 0,
			frequencyBinCount: 128,
			getByteFrequencyData: (bins: Uint8Array) => bins.fill(SPECTRUM_LEVEL),
		};
	}
	createMediaStreamSource() {
		return node();
	}
	createGain() {
		return { ...node(), gain: { value: 1 } };
	}
	createScriptProcessor() {
		const processor: FakeProcessor & ReturnType<typeof node> = { ...node(), onaudioprocess: null };
		this.processor = processor;
		return processor;
	}
	/** The microphone hears `samples` (at this context's rate). */
	feed(samples: Float32Array): void {
		this.processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

export interface FakeMic {
	/** Every stream `getUserMedia` handed out, oldest first. */
	streams: FakeStream[];
	getUserMedia: Mock<(constraints: MediaStreamConstraints) => Promise<FakeStream>>;
	/** The capture context of the take in flight. */
	context: () => FakeAudioContext;
}

/** Stub the audio globals and `navigator.mediaDevices`; undo with {@link uninstallFakeMic}. */
export function installFakeMic(): FakeMic {
	const streams: FakeStream[] = [];
	const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints): Promise<FakeStream> => {
		const stream = new FakeStream();
		streams.push(stream);
		return stream;
	});
	FakeAudioContext.instances = [];
	vi.stubGlobal("AudioContext", FakeAudioContext);
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
	return {
		streams,
		getUserMedia,
		context: () => {
			const context = FakeAudioContext.instances.at(-1);
			if (!context) throw new Error("no capture context yet");
			return context;
		},
	};
}

export function uninstallFakeMic(): void {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "mediaDevices");
}

/** The bytes of a base64 payload (a WAV, or a live take's PCM16). */
export function decodeBase64(base64: string): DataView {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new DataView(bytes.buffer);
}
