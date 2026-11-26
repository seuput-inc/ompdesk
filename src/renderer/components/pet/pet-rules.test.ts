/** The desktop pet's state rule, saved position and custom sprite checks (pet-rules.ts). */
import { describe, expect, it } from "vitest";
import {
	clampPetPosition,
	finishedTurn,
	PET_SPRITE_MAX_BYTES,
	parsePetPosition,
	parsePetSprite,
	petState,
	spriteFileProblem,
	spriteFrames,
} from "./pet-rules";

const run = (id: string, state: "waiting" | "running" | "idle") => ({
	id,
	waiting: state === "waiting",
	running: state === "running",
});

describe("petState", () => {
	it("puts waiting over working over a just-finished turn over idle", () => {
		expect(petState([run("a", "running"), run("b", "waiting")], true)).toBe("waiting");
		expect(petState([run("a", "idle"), run("b", "running")], true)).toBe("working");
		expect(petState([run("a", "idle")], true)).toBe("done");
		expect(petState([run("a", "idle")], false)).toBe("idle");
		expect(petState([], false)).toBe("idle");
	});

	it("counts a turn finished only when a running session stops without waiting", () => {
		const was = new Set(["a"]);
		expect(finishedTurn(was, [run("a", "idle")])).toBe(true);
		expect(finishedTurn(was, [run("a", "waiting")])).toBe(false);
		expect(finishedTurn(was, [run("a", "running")])).toBe(false);
		expect(finishedTurn(was, [run("b", "idle")])).toBe(false);
		expect(finishedTurn(new Set(), [run("a", "idle")])).toBe(false);
	});
});

describe("pet position", () => {
	it("reads only finite numbers", () => {
		expect(parsePetPosition({ right: 10, bottom: 20 })).toEqual({ right: 10, bottom: 20 });
		expect(parsePetPosition({ right: "10", bottom: 20 })).toBeNull();
		expect(parsePetPosition({ right: Number.NaN, bottom: 20 })).toBeNull();
		expect(parsePetPosition(null)).toBeNull();
	});

	it("keeps the pet inside the window", () => {
		const viewport = { width: 800, height: 600 };
		expect(clampPetPosition({ right: -40, bottom: 9000 }, viewport)).toEqual({ right: 0, bottom: 536 });
		expect(clampPetPosition({ right: 100, bottom: 100 }, viewport)).toEqual({ right: 100, bottom: 100 });
		expect(clampPetPosition({ right: 100, bottom: 100 }, { width: 30, height: 30 })).toEqual({ right: 0, bottom: 0 });
	});
});

describe("custom sprite", () => {
	it("refuses a file of another type, an empty one or one over the cap", () => {
		expect(spriteFileProblem({ type: "image/png", size: 1000 })).toBeNull();
		expect(spriteFileProblem({ type: "image/webp", size: PET_SPRITE_MAX_BYTES })).toBeNull();
		expect(spriteFileProblem({ type: "image/svg+xml", size: 1000 })).toBe("type");
		expect(spriteFileProblem({ type: "image/jpeg", size: 1000 })).toBe("type");
		expect(spriteFileProblem({ type: "image/gif", size: PET_SPRITE_MAX_BYTES + 1 })).toBe("size");
		expect(spriteFileProblem({ type: "image/gif", size: 0 })).toBe("unreadable");
	});

	it("reads a stored sprite only as a base64 PNG, GIF or WebP data URL within the cap", () => {
		const png = "data:image/png;base64,iVBORw0KGgo=";
		expect(parsePetSprite(png)).toBe(png);
		expect(parsePetSprite("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
		expect(parsePetSprite("data:image/png,raw")).toBeNull();
		expect(parsePetSprite("https://example.com/pet.png")).toBeNull();
		expect(parsePetSprite(42)).toBeNull();
		const tooBig = `data:image/png;base64,${"A".repeat(Math.ceil((PET_SPRITE_MAX_BYTES + 3) / 3) * 4)}`;
		expect(parsePetSprite(tooBig)).toBeNull();
		const atCap = `data:image/png;base64,${"A".repeat(Math.floor(PET_SPRITE_MAX_BYTES / 3) * 4)}`;
		expect(parsePetSprite(atCap)).toBe(atCap);
	});

	it("steps through a strip of square frames and shows any other picture whole", () => {
		expect(spriteFrames(256, 64)).toBe(4);
		expect(spriteFrames(64, 64)).toBe(1);
		expect(spriteFrames(250, 64)).toBe(1);
		expect(spriteFrames(64, 256)).toBe(1);
		expect(spriteFrames(64 * 40, 64)).toBe(1);
		expect(spriteFrames(0, 0)).toBe(1);
	});
});
