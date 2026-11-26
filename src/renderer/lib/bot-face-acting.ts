/**
 * What a bot's face acts out (adapted from momobot's `app/src/lib/agents/avatar-acting.ts`, MIT;
 * LICENSES/MIT-momobot.txt): each visible state (`FacePresence`) is one whole pose (`presencePose`), and a change of
 * state plays a short, finite phrase of beats (`entryBeats`) into it. A held state never repeats a phrase; nothing here
 * runs on a clock.
 */

import { clamp, type FacePose, type FacePresence, REST_FACE_POSE } from "./bot-face";
import type { AvatarDynamics, AvatarLook } from "./bot-face-rig";

/** A state is one whole expression; the rig blends into it without losing velocity. */
export function presencePose(state: FacePresence, look: AvatarLook): FacePose {
	const pose: FacePose = { ...REST_FACE_POSE };
	switch (state) {
		case "thinking":
			Object.assign(pose, {
				leftOpen: 0.57,
				rightOpen: 0.97,
				leftTilt: -9,
				rightTilt: 3,
				y: 0.5,
				stretch: -0.07,
				crown: 0.18,
				bend: 0.45,
				leftWidth: 1.12,
			});
			break;
		case "waiting":
			// Expectant and facing the person: eyes open and softened, the body lifted a little.
			Object.assign(pose, {
				leftOpen: 1.14,
				rightOpen: 1.14,
				leftCurve: 0.14,
				rightCurve: 0.14,
				y: -0.35,
				stretch: 0.035,
				eyeSpread: 1.02,
			});
			break;
		case "happy":
			Object.assign(pose, {
				leftOpen: 0.12,
				rightOpen: 0.12,
				leftCurve: 1,
				rightCurve: 1,
				y: -0.6,
				stretch: 0.025,
				eyeSpread: 1.06,
			});
			break;
		case "troubled":
			Object.assign(pose, {
				leftOpen: 0.28,
				rightOpen: 0.28,
				leftWidth: 1.35,
				rightWidth: 1.35,
				leftCurve: -0.15,
				rightCurve: -0.15,
				leftTilt: -23,
				rightTilt: 23,
				y: 1.1,
				stretch: -0.1,
				crown: -0.18,
			});
			break;
		case "idle":
			break;
	}
	const pull = state === "happy" || state === "troubled" ? 0.3 : state === "waiting" ? 0.8 : 1;
	pose.gazeX = clamp(look.x, -1.2, 1.2) * pull;
	pose.gazeY = clamp(look.y, -1.2, 1.2) * pull;
	pose.yaw = pose.gazeX;
	pose.pitch = pose.gazeY;
	pose.x = pose.gazeX * 0.4;
	pose.roll += pose.gazeX * 5;
	pose.bend += pose.gazeX * 0.42;
	return pose;
}

export type AvatarTiming = { bodyPace: number; eyePace: number; bodyDamping: number };

type Phase = "notice" | "anticipate" | "engage" | "inspect" | "hold" | "release" | "settle" | "rest";
type Beat = {
	phase: Exclude<Phase, "rest">;
	milliseconds: number;
	pose: Partial<FacePose>;
	timing?: Partial<AvatarTiming>;
};

const TIMING: Record<FacePresence, AvatarTiming> = {
	idle: { bodyPace: 0.78, eyePace: 0.95, bodyDamping: 0.96 },
	thinking: { bodyPace: 0.65, eyePace: 0.92, bodyDamping: 0.98 },
	waiting: { bodyPace: 0.64, eyePace: 0.85, bodyDamping: 1 },
	happy: { bodyPace: 1, eyePace: 1.02, bodyDamping: 0.72 },
	troubled: { bodyPace: 0.8, eyePace: 1.05, bodyDamping: 1 },
};

const beat = (
	phase: Beat["phase"],
	milliseconds: number,
	pose: Partial<FacePose>,
	timing?: Partial<AvatarTiming>,
): Beat => ({ phase, milliseconds, pose, timing });

/** Finite acting phrases, started by real state changes. */
function entryBeats(state: FacePresence, before: FacePresence, from: FacePose, look: AvatarLook): Beat[] {
	const side = look.x < 0 ? -1 : 1;
	switch (state) {
		case "thinking":
			return [
				...(before === "idle"
					? [
							beat(
								"notice",
								90,
								{
									yaw: from.yaw,
									pitch: from.pitch,
									roll: from.roll,
									x: from.x,
									gazeX: 0,
									gazeY: 0.1,
									leftOpen: 1.25,
									rightOpen: 1.25,
									y: -0.2,
									stretch: 0.035,
								},
								{ eyePace: 1.6, bodyPace: 0.8 },
							),
							beat(
								"anticipate",
								130,
								{ y: 0.95, stretch: -0.065, blinkLeft: 0.95, blinkRight: 0.85, gazeX: 0, gazeY: 0.25 },
								{ bodyPace: 1.6, bodyDamping: 0.86 },
							),
						]
					: []),
				beat(
					"inspect",
					380,
					{
						gazeX: side * 0.95,
						gazeY: -1.05,
						yaw: side * 0.6,
						pitch: -0.7,
						leftOpen: 0.38,
						rightOpen: 0.95,
						crown: 0.2,
						stretch: -0.075,
						y: 0.4,
					},
					{ bodyPace: 0.68, eyePace: 1.25 },
				),
				beat(
					"hold",
					290,
					{ gazeX: side * 0.9, gazeY: -0.85, leftOpen: 0.42, rightOpen: 0.88, crown: 0.18 },
					{ bodyPace: 0.55 },
				),
				beat("settle", 320, {}),
			];
		case "waiting":
			// Turns to the person and asks for their attention once: lifted, eyes open, two soft blinks.
			return [
				beat(
					"notice",
					120,
					{ gazeX: 0, gazeY: 0, yaw: 0, pitch: 0, leftOpen: 1.28, rightOpen: 1.28, y: -0.55, stretch: 0.05 },
					{ eyePace: 1.5, bodyPace: 1.2 },
				),
				beat("anticipate", 110, { gazeX: 0, gazeY: 0, blinkLeft: 0.9, blinkRight: 0.88 }, { eyePace: 1.6 }),
				beat("hold", 200, { gazeX: 0, gazeY: 0, leftOpen: 1.2, rightOpen: 1.2, y: -0.45 }),
				beat("anticipate", 100, { gazeX: 0, gazeY: 0, blinkLeft: 0.85, blinkRight: 0.85 }, { eyePace: 1.6 }),
				beat("settle", 460, {}),
			];
		case "happy":
			return [
				beat(
					"anticipate",
					110,
					{ y: 0.8, stretch: -0.085, leftCurve: 0.55, rightCurve: 0.55, leftOpen: 0.4, rightOpen: 0.4 },
					{ bodyPace: 1.6 },
				),
				beat(
					"engage",
					190,
					{ y: -1.55, stretch: 0.115, crown: 0.08, leftCurve: 1, rightCurve: 1, leftOpen: 0.12, rightOpen: 0.12 },
					{ bodyPace: 1.55, bodyDamping: 0.68 },
				),
				beat("release", 220, { y: 0.55, stretch: -0.075 }, { bodyPace: 1.35, bodyDamping: 0.85 }),
				beat("hold", 320, { y: -0.35, stretch: 0.025 }),
				beat("settle", 440, {}),
			];
		case "troubled":
			return [
				beat(
					"notice",
					100,
					{
						y: -0.7,
						stretch: 0.095,
						leftOpen: 1.3,
						rightOpen: 1.3,
						leftTilt: 0,
						rightTilt: 0,
						leftCurve: 0,
						rightCurve: 0,
					},
					{ bodyPace: 1.75, eyePace: 1.8 },
				),
				beat(
					"release",
					190,
					{
						x: -side * 0.6,
						y: 0.7,
						stretch: -0.12,
						crown: -0.16,
						gazeX: 0,
						gazeY: 0,
						leftOpen: 0.4,
						rightOpen: 0.4,
					},
					{ bodyPace: 1.35 },
				),
				// A small, decaying head shake: three swings, then it stops for good.
				beat("release", 110, { x: -side * 0.9, roll: -6 }, { bodyPace: 1.7 }),
				beat("release", 110, { x: side * 0.7, roll: 5 }, { bodyPace: 1.7 }),
				beat("release", 120, { x: -side * 0.4, roll: -2.5 }, { bodyPace: 1.5 }),
				beat("hold", 360, { gazeX: 0, gazeY: -0.05, yaw: 0, pitch: 0, leftOpen: 0.38, rightOpen: 0.38 }),
				beat("settle", 480, {}),
			];
		case "idle":
			return before === "happy"
				? [
						beat("release", 370, { leftCurve: 0.55, rightCurve: 0.55, leftOpen: 0.42, rightOpen: 0.42, y: 0.15 }),
						beat("settle", 640, {}),
					]
				: [
						beat("release", 280, { y: 0.4, stretch: -0.035, leftOpen: 0.85, rightOpen: 0.85 }),
						beat("settle", 620, {}),
					];
	}
}

/** Directs the springs. A retarget keeps their current position and velocity. */
export class AvatarPerformance {
	#state: FacePresence = "idle";
	#look: AvatarLook = { x: 0, y: 0 };
	#head: AvatarLook = { x: 0, y: 0 };
	#sequence: { name: string; beats: Beat[]; index: number; elapsed: number } | null = null;
	readonly #driver: AvatarDynamics;
	readonly #tempo: number;
	/** How long this face takes to react to a new state, in ms: faces told one thing at once do not move in lockstep. */
	readonly #latencyMs: number;

	constructor(driver: AvatarDynamics, tempo: number, latencyMs: number) {
		this.#driver = driver;
		this.#tempo = tempo;
		this.#latencyMs = latencyMs;
	}

	#apply(): boolean {
		const current = this.#sequence?.beats[this.#sequence.index];
		this.#driver.setTiming({ ...TIMING[this.#state], ...current?.timing });
		const eyes = presencePose(this.#state, this.#look);
		return this.#driver.retarget({
			...presencePose(this.#state, this.#head),
			gazeX: eyes.gazeX,
			gazeY: eyes.gazeY,
			...current?.pose,
		});
	}

	#start(name: string, beats: Beat[]): boolean {
		this.#sequence = { name, beats, index: 0, elapsed: 0 };
		this.#apply();
		return true;
	}

	/** A new state or look; true when the springs have somewhere to go. `animate` false lands it in one cut. */
	update(next: FacePresence, look: AvatarLook, animate: boolean, followHead: boolean): boolean {
		const before = this.#state;
		this.#state = next;
		this.#look = look;
		if (followHead) this.#head = look;
		if (!animate) {
			this.finish();
			return false;
		}
		if (before !== next) {
			const beats = entryBeats(next, before, this.#driver.pose, look);
			// The reaction time before an entrance: the face stays where it is, still moving as it was.
			const still = beat("hold", this.#latencyMs, { ...this.#driver.pose, blinkLeft: 0, blinkRight: 0 });
			return this.#start("enter", [still, ...beats]);
		}
		return this.#apply();
	}

	finish(): void {
		this.#sequence = null;
		this.#apply();
		this.#driver.settle();
	}

	/** A pointer that lingered near the face: it looks up and leans in once. */
	notice(): boolean {
		if (this.#state !== "idle" && this.#state !== "waiting") return false;
		if (this.#sequence?.name === "enter") return false;
		const from = this.#driver.pose;
		return this.#start("notice", [
			beat(
				"notice",
				85,
				{ yaw: from.yaw, pitch: from.pitch, roll: from.roll, leftOpen: 1.22, rightOpen: 1.25 },
				{ eyePace: 1.65 },
			),
			beat("inspect", 250, { y: -0.55, stretch: 0.035, leftOpen: 1.12, rightOpen: 1.17 }, { bodyPace: 1.05 }),
			beat("settle", 450, {}),
		]);
	}

	/** Pressed: a squash and a bounce. */
	touch(): boolean {
		if (this.#state === "troubled") return false;
		return this.#start("touch", [
			beat("anticipate", 95, { y: 1, stretch: -0.12, blinkLeft: 0.9, blinkRight: 0.85 }, { bodyPace: 1.8 }),
			beat("release", 190, { y: -0.7, stretch: 0.065 }, { bodyPace: 1.4, bodyDamping: 0.75 }),
			beat("settle", 370, {}),
		]);
	}

	step(seconds: number): boolean {
		// Resuming an unpainted window shows its current state, not an old acknowledgement.
		if (seconds > 0.4) {
			this.finish();
			return false;
		}
		let remaining = Math.max(0, seconds);
		while (remaining > 0) {
			const current = this.#sequence?.beats[this.#sequence.index];
			const duration = current ? (current.milliseconds * this.#tempo) / 1000 : Number.POSITIVE_INFINITY;
			const elapsed = (this.#sequence?.elapsed ?? 0) / 1000;
			const segment = Math.min(remaining, Math.max(0, duration - elapsed));
			this.#driver.step(segment);
			remaining -= segment;
			if (!this.#sequence) break;
			this.#sequence.elapsed += segment * 1000;
			if (this.#sequence.elapsed >= duration * 1000 - 0.001) {
				this.#sequence.index++;
				this.#sequence.elapsed = 0;
				if (this.#sequence.index === this.#sequence.beats.length) this.#sequence = null;
				this.#apply();
			}
		}
		return this.#sequence !== null || this.#driver.step(0);
	}
}
