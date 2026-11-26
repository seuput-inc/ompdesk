/** `stt_prepare` (voice.ts): the shapes main and the renderer read. Dependency-free. */

export type SttModelState =
	| { state: "ready" }
	| { state: "downloading"; percent: number }
	/** The last download `stt_prepare` started failed; reported once, so the next one tries again. */
	| { state: "failed"; error: string };

/** The language heard (a code; null when none is set), the model the rule picks for it, and where its weights stand. */
export type SttPrepareResult = { language: string | null; modelKey: string } & SttModelState;

/**
 * `stt_stream_start`: a live take on stock's streaming session, or none when the language's model is not here yet (the
 * take is then transcribed whole by `transcribe_audio`, which waits for that model's download).
 */
export interface SttStreamStart {
	streamId: string | null;
}

/**
 * `stt_stream_audio`: the words of the take so far (`text`: the segments stock's endpointer committed, `partial`: the
 * segment still being spoken) and how long no speech was heard (since the last words, else since the take started).
 */
export interface SttStreamWords {
	text: string;
	partial: string;
	quietMs: number;
}
