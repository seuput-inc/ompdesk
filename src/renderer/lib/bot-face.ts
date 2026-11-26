/**
 * A bot's drawn face (adapted from momobot's `app/src/lib/agents/bot-face.ts`, MIT; LICENSES/MIT-momobot.txt): a small
 * character in its own 32-unit coordinates whose look (body colour, roundness, eye size, gap, height and tilt) comes
 * from a seed, the bot's id, so the same bot has the same face on every device. `faceDrawing` turns those traits and a
 * pose into the SVG contours; `REST_FACE_POSE` is the face at rest, what the first paint, reduced motion and the test
 * captures show. The rig (`bot-face-rig.ts`, loaded on demand) moves the same contours in place.
 */

export const FACE_VIEWBOX = 32;

export type FaceTraits = {
	bodyColor: string;
	/** Cubic circle handles; a little more gives the head a softer square silhouette. */
	roundness: number;
	eyeWidth: number;
	eyeHeight: number;
	eyeGap: number;
	eyeY: number;
	eyeTilt: number;
};

export type FacePose = {
	x: number;
	y: number;
	yaw: number;
	pitch: number;
	gazeX: number;
	gazeY: number;
	roll: number;
	stretch: number;
	bend: number;
	crown: number;
	leftOpen: number;
	rightOpen: number;
	leftWidth: number;
	rightWidth: number;
	leftCurve: number;
	rightCurve: number;
	leftTilt: number;
	rightTilt: number;
	eyeSpread: number;
	blinkLeft: number;
	blinkRight: number;
};

/**
 * What a face shows, from its bot's facts: `idle`, `thinking` (one of its chats is running), `waiting` (it needs the
 * person), `troubled` (its newest chat failed) and `happy` (a run just ended well; the rig plays it briefly itself).
 */
export type FacePresence = "idle" | "thinking" | "waiting" | "troubled" | "happy";

export const REST_FACE_POSE: Readonly<FacePose> = {
	x: 0,
	y: 0,
	yaw: 0,
	pitch: 0,
	gazeX: 0,
	gazeY: 0,
	roll: 0,
	stretch: 0,
	bend: 0,
	crown: 0,
	leftOpen: 1,
	rightOpen: 1,
	leftWidth: 1,
	rightWidth: 1,
	leftCurve: 0,
	rightCurve: 0,
	leftTilt: 0,
	rightTilt: 0,
	eyeSpread: 1,
	blinkLeft: 0,
	blinkRight: 0,
};

const HUES = [8, 32, 50, 96, 138, 166, 190, 212, 244, 272, 302, 330];
const SATURATIONS = [46, 57, 68];
const LIGHTNESSES = [38, 45, 52];
const round = (n: number) => Math.round(n * 1000) / 1000;
export const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** FNV-1a: small and stable across reloads and machines, which is the whole requirement. */
export function hashSeed(seed: string): number {
	let hash = 0x81_1c_9d_c5;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01_00_01_93);
	}
	return hash >>> 0;
}

/** A deterministic xorshift stream in [0, 1) from `seed`. */
export function seededStream(seed: string): () => number {
	let state = hashSeed(seed) || 0x9e_37_79_b9;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_00_00_00_00;
	};
}

export function faceTraits(seed: string): FaceTraits {
	const random = seededStream(seed);
	const hue = HUES[Math.floor(random() * HUES.length)];
	const saturation = SATURATIONS[Math.floor(random() * SATURATIONS.length)];
	const lightness = LIGHTNESSES[Math.floor(random() * LIGHTNESSES.length)];
	return {
		bodyColor: `hsl(${hue} ${saturation}% ${lightness}%)`,
		roundness: round(0.55 + random() * 0.09),
		eyeWidth: round(3.3 + random() * 0.8),
		eyeHeight: round(6.8 + random() * 1.4),
		eyeGap: round(3.7 + random() * 0.7),
		eyeY: round(-2.1 + random() * 0.9),
		eyeTilt: round(-3 + random() * 6),
	};
}

/** The outline itself deforms: the face is not a picture scaled inside another circle. */
function bodyPath(traits: FaceTraits, pose: FacePose): string {
	const stretch = clamp(pose.stretch, -0.18, 0.18);
	const w = 14.35 * (1 - stretch * 0.48) * (1 - Math.abs(pose.yaw) * 0.035);
	const h = 14.35 * (1 + stretch);
	const b = clamp(pose.bend, -1.4, 1.4);
	const k = traits.roundness;
	const upper = w * k * (1 + clamp(pose.crown, -0.25, 0.25));
	const lower = w * k * (1 - clamp(pose.crown, -0.25, 0.25));
	return [
		`M${round(b)} ${round(-h)}`,
		`C${round(upper + b)} ${round(-h)} ${round(w)} ${round(-h * k)} ${round(w)} 0`,
		`C${round(w)} ${round(h * k)} ${round(lower - b)} ${round(h)} ${round(-b)} ${round(h)}`,
		`C${round(-lower - b)} ${round(h)} ${round(-w)} ${round(h * k)} ${round(-w)} 0`,
		`C${round(-w)} ${round(-h * k)} ${round(-upper + b)} ${round(-h)} ${round(b)} ${round(-h)}Z`,
	].join(" ");
}

/** One continuous contour can be a tall eye, a squint or a smiling crescent. */
function eyePath(width: number, height: number, curve: number): string {
	const w = Math.max(0.8, width) / 2;
	const h = Math.max(1.15, height) / 2;
	const radius = Math.min(w, h);
	const x = w - radius;
	const y = h - radius;
	const k = radius * 0.5523;
	// A rounded capsule bent into an expressive lid: every state keeps the same contour.
	const point = (px: number, py: number) => `${round(px)} ${round(py - curve * 2.5 * (1 - (px / w) ** 2))}`;
	return [
		`M${point(x, -h)}`,
		`C${point(x + k, -h)} ${point(w, -y - k)} ${point(w, -y)}`,
		`C${point(w, -y / 3)} ${point(w, y / 3)} ${point(w, y)}`,
		`C${point(w, y + k)} ${point(x + k, h)} ${point(x, h)}`,
		`C${point(x / 3, h)} ${point(-x / 3, h)} ${point(-x, h)}`,
		`C${point(-x - k, h)} ${point(-w, y + k)} ${point(-w, y)}`,
		`C${point(-w, y / 3)} ${point(-w, -y / 3)} ${point(-w, -y)}`,
		`C${point(-w, -y - k)} ${point(-x - k, -h)} ${point(-x, -h)}`,
		`C${point(-x / 3, -h)} ${point(x / 3, -h)} ${point(x, -h)}Z`,
	].join(" ");
}

export function faceDrawing(traits: FaceTraits, pose: FacePose) {
	const eye = (side: -1 | 1) => {
		const left = side === -1;
		const open = clamp(left ? pose.leftOpen : pose.rightOpen, 0.08, 1.35);
		const blink = clamp(left ? pose.blinkLeft : pose.blinkRight, 0, 1);
		const curve = left ? pose.leftCurve : pose.rightCurve;
		// Features travel over a round surface: the far eye narrows and approaches the silhouette.
		const angle = (side * traits.eyeGap * pose.eyeSpread) / 12.5 + pose.yaw * 0.27 + pose.gazeX * 0.19;
		const x = Math.sin(angle) * 12.5;
		const y = traits.eyeY + pose.pitch * 2 + pose.gazeY * 1.4 + (1 - Math.cos(angle)) * pose.pitch;
		const width =
			traits.eyeWidth *
			Math.cos(angle) *
			(1 + Math.abs(curve) * 0.48) *
			clamp(left ? pose.leftWidth : pose.rightWidth, 0.65, 1.45);
		const height = traits.eyeHeight * open * (1 - blink * 0.93) * (1 + pose.stretch * 0.3);
		const tilt = traits.eyeTilt + (left ? pose.leftTilt : pose.rightTilt) - pose.yaw * 6;
		return {
			path: eyePath(width, height, curve),
			transform: `translate(${round(x)} ${round(y)}) rotate(${round(tilt)})`,
		};
	};
	return {
		body: bodyPath(traits, pose),
		transform: `translate(${round(16 + pose.x)} ${round(16 + pose.y)}) rotate(${round(pose.roll)})`,
		left: eye(-1),
		right: eye(1),
	};
}
