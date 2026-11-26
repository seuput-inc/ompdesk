/**
 * Hold to dictate, as Orca's Auto mode (`use-hold-dictation-gesture.ts:32-33,157-206`, commit 02cecc98): a press
 * starts a take, or ends the one running; a press held at least {@link HOLD_MS} records until its release, a shorter
 * tap leaves the take running until the next press. One rule for the mic button and the `voice.dictate` key.
 */

/** A press held this long records until release. */
export const HOLD_MS = 300;

export type PressAction = "start" | "stop" | null;

export class DictationPress {
	#pressedAt: number | null = null;

	/** A press began; `underway`: a take is starting or recording. */
	down(now: number, underway: boolean): PressAction {
		if (underway) {
			this.#pressedAt = null;
			return "stop";
		}
		this.#pressedAt = now;
		return "start";
	}

	/** The press ended (released, or lost to a blur): a held one stops the take it started. */
	up(now: number): PressAction {
		const pressedAt = this.#pressedAt;
		this.#pressedAt = null;
		return pressedAt !== null && now - pressedAt >= HOLD_MS ? "stop" : null;
	}

	/** A press that started the take is still down: silence never ends the take then. */
	get holding(): boolean {
		return this.#pressedAt !== null;
	}
}
