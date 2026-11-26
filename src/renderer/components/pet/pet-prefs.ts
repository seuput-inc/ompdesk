/**
 * The desktop pet's prefs, shared by the overlay and its Settings row and kept in main's prefs (never localStorage)
 * so every window of this computer agrees: `desktopPet` (on/off, default off), `desktopPetSprite` (a custom sprite as
 * a data URL, absent for the built-in pet) and `desktopPetPosition` (`PetPosition`). Three keys, so a drag never
 * rewrites the sprite. Read once, then again whenever main says another window wrote one.
 */
import { create } from "zustand";
import { saveGuiPreference } from "../../lib/display-preferences";
import { translate } from "../../lib/i18n";
import { readPref } from "../../lib/prefs-read";
import { toast } from "../../stores/toast";
import {
	PET_SPRITE_MAX_BYTES,
	type PetPosition,
	parsePetPosition,
	parsePetSprite,
	type SpriteProblem,
	spriteFileProblem,
} from "./pet-rules";

export const PET_ENABLED_PREF = "desktopPet";
export const PET_SPRITE_PREF = "desktopPetSprite";
export const PET_POSITION_PREF = "desktopPetPosition";

interface PetPrefs {
	enabled: boolean;
	sprite: string | null;
	position: PetPosition | null;
}

export const usePetPrefs = create<PetPrefs>()(() => ({ enabled: false, sprite: null, position: null }));

const PARSE: Record<string, (value: unknown) => Partial<PetPrefs>> = {
	[PET_ENABLED_PREF]: value => ({ enabled: value === true }),
	[PET_SPRITE_PREF]: value => ({ sprite: parsePetSprite(value) }),
	[PET_POSITION_PREF]: value => ({ position: parsePetPosition(value) }),
};

async function load(key: string): Promise<void> {
	const read = await readPref(key);
	const parse = PARSE[key];
	if (read.ok && parse) usePetPrefs.setState(parse(read.value));
}

let followed = false;

/** Load the prefs and follow other windows' writes; a missing bridge (tests) is skipped. */
export function followPetPrefs(): void {
	if (followed || typeof window === "undefined" || typeof window.omp?.prefs?.get !== "function") return;
	followed = true;
	for (const key of Object.keys(PARSE)) void load(key);
	window.omp.prefs.onChanged?.(event => {
		if (event.key in PARSE) void load(event.key);
	});
}

export function setPetEnabled(enabled: boolean): Promise<boolean> {
	return saveGuiPreference(PET_ENABLED_PREF, enabled, () => usePetPrefs.setState({ enabled }));
}

/** Shown where it was dropped at once; the write follows. */
export function setPetPosition(position: PetPosition): Promise<boolean> {
	usePetPrefs.setState({ position });
	return saveGuiPreference(PET_POSITION_PREF, position, () => {});
}

export function resetPetSprite(): Promise<boolean> {
	return saveGuiPreference(PET_SPRITE_PREF, null, () => usePetPrefs.setState({ sprite: null }));
}

function refuse(problem: SpriteProblem): void {
	toast({
		variant: "error",
		title: translate("pet.spriteFailed"),
		message: translate(`pet.spriteProblem.${problem}`, { max: PET_SPRITE_MAX_BYTES / 1024 }),
	});
}

function readDataUrl(file: Blob): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	const reader = new FileReader();
	reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
	reader.onerror = () => resolve(null);
	reader.readAsDataURL(file);
	return promise;
}

function decodes(url: string): Promise<boolean> {
	const image = new Image();
	image.src = url;
	return image.decode().then(
		() => image.naturalWidth > 0 && image.naturalHeight > 0,
		() => false,
	);
}

/** Make a picked file the pet's sprite, or say why it cannot be (wrong type, too large, not a picture). */
export async function importPetSprite(file: File): Promise<boolean> {
	const problem = spriteFileProblem(file);
	if (problem) {
		refuse(problem);
		return false;
	}
	const url = await readDataUrl(file);
	const sprite = url ? parsePetSprite(url) : null;
	if (!sprite || !(await decodes(sprite))) {
		refuse("unreadable");
		return false;
	}
	return saveGuiPreference(PET_SPRITE_PREF, sprite, () => usePetPrefs.setState({ sprite }));
}
