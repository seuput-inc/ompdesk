/**
 * The physical rig under a bot's face (adapted from momobot's `app/src/lib/agents/avatar-rig.ts`, MIT;
 * LICENSES/MIT-momobot.txt): every pose value is a damped spring (`AvatarDynamics`), and one shared animation-frame
 * queue draws only the faces whose pose is still settling. A settled, hidden or motion-reduced face leaves the queue,
 * so a page of resting faces asks for no frame at all.
 */

import { clamp, type FacePose, type FacePresence, faceDrawing, faceTraits, REST_FACE_POSE } from "./bot-face";
import { AvatarPerformance, type AvatarTiming } from "./bot-face-acting";

export type AvatarLook = { x: number; y: number };
export type Personality = { tempo: number; lookDelayMs: number; latencyMs: number };
type PoseKey = keyof FacePose;
const KEYS = Object.keys(REST_FACE_POSE) as PoseKey[];
const BODY: Partial<Record<PoseKey, true>> = {
	x: true,
	y: true,
	yaw: true,
	pitch: true,
	roll: true,
	stretch: true,
	bend: true,
	crown: true,
};
const SQUASH: Partial<Record<PoseKey, true>> = { y: true, stretch: true, bend: true, crown: true };

/** Exact damped-spring integration: the result does not depend on the display's refresh rate. */
export function advanceSpring(
	value: number,
	velocity: number,
	target: number,
	seconds: number,
	frequency: number,
	damping: number,
): { value: number; velocity: number } {
	const displacement = value - target;
	const decay = Math.exp(-damping * frequency * seconds);
	if (damping === 1) {
		const c = velocity + frequency * displacement;
		return {
			value: target + decay * (displacement + c * seconds),
			velocity: decay * (velocity - frequency * c * seconds),
		};
	}
	const damped = frequency * Math.sqrt(1 - damping * damping);
	const sin = Math.sin(damped * seconds);
	const cos = Math.cos(damped * seconds);
	return {
		value: target + decay * (displacement * cos + ((velocity + damping * frequency * displacement) / damped) * sin),
		velocity:
			decay *
			(velocity * cos - ((damping * frequency * velocity + frequency * frequency * displacement) / damped) * sin),
	};
}

/** Pure dynamics; scheduling and drawing live below. */
export class AvatarDynamics {
	readonly pose: FacePose = { ...REST_FACE_POSE };
	readonly velocity = Object.fromEntries(KEYS.map(key => [key, 0])) as FacePose;
	#target: FacePose = { ...REST_FACE_POSE };
	#timing: AvatarTiming = { bodyPace: 1, eyePace: 1, bodyDamping: 0.64 };
	readonly #personality: Personality;

	constructor(personality: Personality) {
		this.#personality = personality;
	}

	retarget(target: FacePose): boolean {
		const changed = KEYS.some(key => target[key] !== this.#target[key]);
		this.#target = target;
		return changed;
	}

	setTiming(timing: AvatarTiming): void {
		this.#timing = timing;
	}

	settle(): void {
		Object.assign(this.pose, this.#target);
		for (const key of KEYS) this.velocity[key] = 0;
	}

	/** The two lids close a few milliseconds apart, then spring open: no blink loop. */
	blink(): void {
		this.velocity.blinkLeft = 108;
		this.velocity.blinkRight = 92;
	}

	step(seconds: number): boolean {
		let moving = false;
		const dt = clamp(seconds, 0, 0.1);
		const { tempo, lookDelayMs } = this.#personality;
		for (const key of KEYS) {
			let frequency = 23 / tempo;
			let damping = 1;
			if (key === "yaw" || key === "pitch" || key === "x" || key === "roll") {
				frequency = (18 - lookDelayMs * 0.065) / tempo;
				damping = 0.84;
			} else if (SQUASH[key]) {
				frequency = 18 / tempo;
				damping = 0.64;
			} else if (key === "gazeX" || key === "gazeY") {
				frequency = 34 / tempo;
			} else if (key === "blinkLeft" || key === "blinkRight") {
				frequency = (key === "blinkLeft" ? 40 : 34) / tempo;
			}
			if (key !== "blinkLeft" && key !== "blinkRight") {
				frequency *= BODY[key] ? this.#timing.bodyPace : this.#timing.eyePace;
				if (SQUASH[key]) damping = this.#timing.bodyDamping;
				else if (BODY[key]) damping = Math.max(0.84, this.#timing.bodyDamping);
			}
			const next = advanceSpring(this.pose[key], this.velocity[key], this.#target[key], dt, frequency, damping);
			if (Math.abs(next.value - this.#target[key]) < 0.001 && Math.abs(next.velocity) < 0.012) {
				this.pose[key] = this.#target[key];
				this.velocity[key] = 0;
			} else {
				this.pose[key] = next.value;
				this.velocity[key] = next.velocity;
				moving = true;
			}
		}
		return moving;
	}
}

type FrameTask = (seconds: number) => boolean;
const frameTasks = new Set<FrameTask>();
let frameId: number | null = null;
let lastFrame = 0;
function tick(now: number) {
	frameId = null;
	const elapsed = lastFrame ? (now - lastFrame) / 1000 : 1 / 60;
	lastFrame = now;
	for (const task of frameTasks) if (!task(elapsed)) frameTasks.delete(task);
	if (frameTasks.size) frameId = requestAnimationFrame(tick);
	else lastFrame = 0;
}
function wake(task: FrameTask) {
	frameTasks.add(task);
	if (frameId === null) frameId = requestAnimationFrame(tick);
}
function sleep(task: FrameTask) {
	frameTasks.delete(task);
	if (frameTasks.size > 0) return;
	if (frameId !== null) cancelAnimationFrame(frameId);
	frameId = null;
	lastFrame = 0;
}

/** Faces in the frame queue: settled, hidden and motion-reduced faces must have left it. */
export function activeFaceCount(): number {
	return frameTasks.size;
}

/** Drives the contours `BotFace` drew in `node` (its `data-face-part` paths) in place, without React. */
export function createAvatarRig(node: HTMLElement, seed: string, personality: Personality) {
	const traits = faceTraits(seed);
	const dynamics = new AvatarDynamics(personality);
	const director = new AvatarPerformance(dynamics, personality.tempo, personality.latencyMs);
	const part = (name: string): SVGElement => {
		const found = node.querySelector<SVGElement>(`[data-face-part="${name}"]`);
		if (!found) throw new Error(`Missing bot face part: ${name}`);
		return found;
	};
	const character = part("character");
	const body = part("body");
	const clip = part("clip");
	const left = part("left");
	const right = part("right");
	let active = false;
	let lastBlink = Number.NEGATIVE_INFINITY;
	const set = (element: SVGElement, name: string, value: string) => {
		if (element.getAttribute(name) !== value) element.setAttribute(name, value);
	};
	const draw = () => {
		const drawing = faceDrawing(traits, dynamics.pose);
		set(character, "transform", drawing.transform);
		set(body, "d", drawing.body);
		set(clip, "d", drawing.body);
		set(left, "d", drawing.left.path);
		set(left, "transform", drawing.left.transform);
		set(right, "d", drawing.right.path);
		set(right, "transform", drawing.right.transform);
	};
	const frame: FrameTask = seconds => {
		const moving = director.step(seconds);
		draw();
		return moving;
	};
	return {
		update(next: FacePresence, look: AvatarLook, followHead: boolean) {
			if (director.update(next, look, active, followHead)) wake(frame);
			if (!active) draw();
		},
		setActive(next: boolean) {
			if (active === next) return;
			active = next;
			if (!active) sleep(frame);
			director.finish();
			draw();
		},
		blink() {
			if (!active || performance.now() - lastBlink < 900) return;
			lastBlink = performance.now();
			dynamics.blink();
			wake(frame);
		},
		notice() {
			if (active && director.notice()) wake(frame);
		},
		touch() {
			if (active && director.touch()) wake(frame);
		},
		dispose() {
			sleep(frame);
		},
	};
}
