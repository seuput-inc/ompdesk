/**
 * Voice over the live session: dictation (stock STT) and read-aloud (stock TTS).
 * Wire shapes match `src/shared/rpc-types.ts`.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "./health";
import { completeOnSmol, type NextPromptSession } from "./modes/next-prompt-engine";
import { currentReplyLanguage } from "./modes/reply-language";
import { asRecord, requiredString } from "./params";
import type { SttStreamStart } from "./stt-language-contracts";
import {
	cleanedDictation,
	DICTATION_CLEANUP_DEADLINE_MS,
	dictationCleanupRequest,
	SttDictation,
	type SttSetup,
	SttStreams,
	speechLanguageOfName,
	transcribeDeadlineMs,
	transcribeWithin,
} from "./stt-language-core";
import type { BridgeMethods } from "./types";

const WAV_HEADER_BYTES = 44;

/** Canonical 44-byte-header mono PCM16 WAV → Float32 samples (the GUI mic transport's only format). */
function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
	if (bytes.length < WAV_HEADER_BYTES) throw new Error("WAV buffer too short for a 44-byte header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") throw new Error("Not a RIFF/WAVE buffer");
	if (ascii(12) !== "fmt " || ascii(36) !== "data") throw new Error("WAV buffer is not in canonical fmt+data layout");
	const format = view.getUint16(20, true);
	const channels = view.getUint16(22, true);
	const sampleRate = view.getUint32(24, true);
	const bits = view.getUint16(34, true);
	if (format !== 1) throw new Error(`Unsupported WAV encoding: format ${format} (only PCM is accepted)`);
	if (channels !== 1) throw new Error(`Unsupported WAV channel count: ${channels} (only mono is accepted)`);
	if (bits !== 16) throw new Error(`Unsupported WAV bit depth: ${bits} (only 16-bit PCM is accepted)`);
	const dataBytes = Math.min(view.getUint32(40, true), bytes.length - WAV_HEADER_BYTES);
	const samples = new Float32Array(Math.floor(dataBytes / 2));
	for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(WAV_HEADER_BYTES + i * 2, true) / 32768;
	return { samples, sampleRate };
}

/**
 * Same resolution as the TUI stt-controller: stale/legacy keys fall back to the default model (an unknown key reads
 * as stock's default catalog entry). The language is the conversation's (Settings › General, the device language by
 * default), else stock's `stt.language`.
 */
async function sttSetup(session: AgentSession): Promise<SttSetup> {
	const [{ resolveRoleChain }, { roleCandidatePool }, { lookup }, { resolveSttModelSpec }] = await Promise.all([
		import("./omp/pi-coding-agent/config/model-resolver"),
		import("./omp/pi-coding-agent/config/model-roles"),
		import("./omp/pi-coding-agent/config/registry"),
		import("./omp/pi-coding-agent/stt/models"),
	]);
	const pool = roleCandidatePool("dictation", session.settings, session.modelRegistry);
	const spec = resolveSttModelSpec(resolveRoleChain("dictation", session.settings, pool)[0]?.model.id);
	return {
		selected: { key: spec.key, englishOnly: spec.englishOnly },
		language:
			speechLanguageOfName(currentReplyLanguage()) ??
			((lookup("stt.language")?.get(session.settings) as string | undefined) || undefined),
	};
}

async function transcribe(session: AgentSession, params: unknown) {
	const { samples, sampleRate } = decodeWav(Buffer.from(requiredString(params, "audioBase64"), "base64"));
	if (sampleRate !== 16_000) {
		throw new Error(`Unsupported sample rate ${sampleRate} Hz — transcribe_audio expects 16 kHz mono PCM16 WAV`);
	}
	if (samples.length === 0) return { text: "" };
	const { modelKey, language } = await dictation.sttModel(params, await sttSetup(session));
	const { sttClient } = await import("./omp/pi-coding-agent/stt/asr-client");
	const text = await transcribeWithin(
		signal => sttClient.transcribe(modelKey, samples, { language, signal }),
		transcribeDeadlineMs(samples.length / sampleRate),
		() => sttClient.terminate(),
	);
	// The language heard: the page drops its filler words (`lib/dictation-text.ts`).
	return { text, ...(language ? { language } : {}) };
}

/** A live take's audio as the page sends it: 16 kHz mono PCM16, little-endian, base64 (no WAV header). */
function decodePcm16(base64: string): Float32Array {
	const bytes = Buffer.from(base64, "base64");
	const samples = new Float32Array(Math.floor(bytes.length / 2));
	for (let i = 0; i < samples.length; i += 1) samples[i] = bytes.readInt16LE(i * 2) / 32768;
	return samples;
}

const streams = new SttStreams();

/** A live take on stock's streaming session (the worker's endpointer commits segments as the speaker pauses). */
async function startStream(session: AgentSession, params: unknown): Promise<SttStreamStart> {
	const route = await dictation.streamModel(params, await sttSetup(session));
	if (!route) return { streamId: null };
	const { sttClient } = await import("./omp/pi-coding-agent/stt/asr-client");
	return {
		streamId: streams.start(
			events => sttClient.startStream(route.modelKey, { language: route.language, ...events }),
			route.language,
		),
	};
}

async function stopStream(params: unknown): Promise<{ text: string; language?: string }> {
	const { sttClient } = await import("./omp/pi-coding-agent/stt/asr-client");
	return streams.stop(requiredString(params, "streamId"), () => sttClient.terminate());
}

/**
 * The person's opt-in model cleanup (Settings › Dictation): one request on stock's `tiny` role, then `smol`, through
 * the bridge's one cheap-request path. Throws when no model answers in time; the page then keeps the words as tidied.
 */
async function cleanUp(session: AgentSession, params: unknown): Promise<{ text: string }> {
	const text = requiredString(params, "text");
	const raw = asRecord(params).terms;
	const terms = Array.isArray(raw) ? raw.filter((term): term is string => typeof term === "string") : [];
	const request = dictationCleanupRequest(text, terms);
	const reply = await completeOnSmol(session as unknown as NextPromptSession, {
		...request,
		roles: ["tiny", "smol"],
		maxTokens: Math.min(4_096, 256 + text.length),
		temperature: 0,
		purpose: "dictation-cleanup",
		deadlineMs: DICTATION_CLEANUP_DEADLINE_MS,
	});
	return { text: cleanedDictation(reply.text) ?? text };
}

/**
 * Stock `resolveLocalSpeechModelId` (tts/vocalizer.ts), on the speech chain stock's `tools/tts` resolves (with
 * `wantsMp3` false it is that function's own `resolveRoleChain` over `roleCandidatePool`): omp's bundle does not
 * export `tts/vocalizer`, and an import of it is a second copy whose role chain reads other settings' slots.
 */
async function localSpeechModelId(
	session: Pick<AgentSession, "settings" | "modelRegistry">,
	fallback: { key: string },
): Promise<string> {
	const { resolveSpeechCandidates } = await import("./omp/pi-coding-agent/tools/tts");
	const local = resolveSpeechCandidates(session.settings, session.modelRegistry, false).find(
		candidate => candidate.model.api === "local-inference",
	);
	return local?.model.id ?? fallback.key;
}

async function synthesize(session: AgentSession, rawText: string) {
	const text = rawText.trim();
	if (!text) return { audioBase64: "", mimeType: "audio/wav" };
	// Dynamic: `tts/*` is a source copy whose first import transpiles omp's source tree (~540 ms of omp's only thread), so it loads on use, not at startup.
	const [{ DEFAULT_TTS_VOICE, TTS_LOCAL_MODELS }, { ttsClient }, { encodeWav }, { lookup }] = await Promise.all([
		import("./omp/pi-coding-agent/tts/models"),
		import("./omp/pi-coding-agent/tts/tts-client"),
		import("./omp/pi-coding-agent/tts/wav"),
		import("./omp/pi-coding-agent/config/registry"),
	]);
	const voice = (lookup("speech.voice")?.get(session.settings) as string | undefined) || DEFAULT_TTS_VOICE;
	const modelKey = await localSpeechModelId(session, TTS_LOCAL_MODELS[0]);
	const audio = await ttsClient.synthesize(modelKey, text, { voice });
	if (!audio) throw new Error("Local TTS model is unavailable — download it from the TUI speech settings first");
	return {
		audioBase64: Buffer.from(encodeWav(audio.pcm, audio.sampleRate)).toString("base64"),
		mimeType: "audio/wav",
	};
}

/** The setup is resolved by the method that asks (`sttSetup`), and stock's downloader loads on the first model check. */
const dictation = new SttDictation<SttSetup>(setup => setup, {
	isCached: async key => (await import("./omp/pi-coding-agent/stt/downloader")).isSttModelCached(key),
	download: async (key, onProgress) => {
		const { downloadSttModel } = await import("./omp/pi-coding-agent/stt/downloader");
		await downloadSttModel(key, progress => onProgress(progress.loaded, progress.total));
	},
});

// One guard per action (capabilities.ts): a missing internal refuses only the methods that use it.
export const methods: BridgeMethods = {
	// One id for both: `stt_prepare` gets the model `transcribe_audio` runs on.
	...guard("dictation", {
		transcribe_audio: async (params, env) => transcribe(env.session(), params),
		stt_prepare: async (params, env) => dictation.sttPrepare(params, await sttSetup(env.session())),
		// Stock's `#warmModel`: a model already here is loaded before the first take needs it.
		stt_warm: async (params, env) => dictation.warm(params, await sttSetup(env.session())),
		stt_stream_start: async (params, env) => startStream(env.session(), params),
		stt_stream_audio: async params =>
			streams.push(requiredString(params, "streamId"), decodePcm16(requiredString(params, "audioBase64"))),
		stt_stream_stop: async params => stopStream(params),
		stt_stream_cancel: async params => {
			streams.cancel(requiredString(params, "streamId"));
			return {};
		},
	}),
	...guard("dictationCleanup", {
		dictation_cleanup: async (params, env) => cleanUp(env.session(), params),
	}),
	...guard("readAloud", {
		synthesize_speech: async (params, env) => {
			const text = asRecord(params).text;
			return synthesize(env.session(), typeof text === "string" ? text : "");
		},
	}),
};
