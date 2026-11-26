/**
 * The desktop pet's pure rules: which state the window's sessions put it in, and what a custom sprite and a saved
 * position may be. Ported from Orca (stablyai/orca 02cecc98, src/renderer/src/components/pet/):
 * - `petState`: pet-agent-state.ts:37-66 (`agentStateAnimation`: waiting first, then working, then done, else idle),
 *   read from OMPdesk's own session runs (`lib/session-run.ts`) instead of Orca's agent-status entries.
 * - `clampPetPosition`: PetOverlay.tsx:213-224 (`clampPositionToViewport`), measured from the bottom-right corner.
 * - `spriteFrames`: sprite-animation-css.ts:44-49 (the uniform `steps(frames)` row), for a horizontal strip of square
 *   frames instead of Orca's manifest grid or frame detection (sprite-frame-detection.ts).
 * - `spriteFileProblem`/`parsePetSprite`: Orca's importer's type and size refusals (pet-import-failure-text.ts:23-33).
 */

export type PetState = "waiting" | "working" | "done" | "idle";

/** How long a finished turn keeps the pet in its done pose. */
export const PET_DONE_MS = 10_000;

/** The pet's box, in CSS pixels. */
export const PET_SIZE = 64;

/** One tab's session as the pet reads it (`sessionRun`'s `waiting` and `running`). */
export interface PetRun {
	id: string;
	waiting: boolean;
	running: boolean;
}

/** Waiting on the person beats work, work beats a turn that just finished, else idle. */
export function petState(runs: readonly PetRun[], justFinished: boolean): PetState {
	if (runs.some(run => run.waiting)) return "waiting";
	if (runs.some(run => run.running)) return "working";
	return justFinished ? "done" : "idle";
}

/** A tab that was running and now neither runs nor waits finished its turn. */
export function finishedTurn(wasRunning: ReadonlySet<string>, runs: readonly PetRun[]): boolean {
	return runs.some(run => wasRunning.has(run.id) && !run.running && !run.waiting);
}

/** Distance of the pet's box from the window's right and bottom edges, so it stays put as the window resizes. */
export interface PetPosition {
	right: number;
	bottom: number;
}

/** Bottom-right, above the composer and its Send button. */
export const PET_DEFAULT_POSITION: PetPosition = { right: 24, bottom: 200 };

export function parsePetPosition(value: unknown): PetPosition | null {
	if (typeof value !== "object" || value === null) return null;
	const { right, bottom } = value as Record<string, unknown>;
	return typeof right === "number" && Number.isFinite(right) && typeof bottom === "number" && Number.isFinite(bottom)
		? { right, bottom }
		: null;
}

export function clampPetPosition(
	position: PetPosition,
	viewport: { width: number; height: number },
	size = PET_SIZE,
): PetPosition {
	const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(0, value), Math.max(0, max)));
	return {
		right: clamp(position.right, viewport.width - size),
		bottom: clamp(position.bottom, viewport.height - size),
	};
}

export const PET_SPRITE_MAX_BYTES = 512 * 1024;
const SPRITE_TYPES = ["image/png", "image/gif", "image/webp"];
const MAX_FRAMES = 32;

export type SpriteProblem = "type" | "size" | "unreadable";

/** Why a picked file cannot be the pet, or null. */
export function spriteFileProblem(file: { type: string; size: number }): SpriteProblem | null {
	if (!SPRITE_TYPES.includes(file.type)) return "type";
	if (file.size > PET_SPRITE_MAX_BYTES) return "size";
	if (file.size === 0) return "unreadable";
	return null;
}

/** A stored sprite: a base64 PNG, GIF or WebP data URL no bigger than the cap allows; anything else is the built-in pet. */
export function parsePetSprite(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const match = /^data:image\/(?:png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match?.[1]) return null;
	return (match[1].length / 4) * 3 <= PET_SPRITE_MAX_BYTES + 2 ? value : null;
}

/** Frames in a horizontal strip of square frames (width a whole multiple of height); 1 for a single picture. */
export function spriteFrames(width: number, height: number): number {
	if (!(width > 0 && height > 0) || width % height !== 0) return 1;
	const frames = width / height;
	return frames >= 2 && frames <= MAX_FRAMES ? frames : 1;
}
