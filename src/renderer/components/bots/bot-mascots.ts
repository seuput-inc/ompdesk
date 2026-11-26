/**
 * The faces a new bot can wear (Orca's mascot carousel, `BotPictureCarousel.tsx` and `BotPictureLook.tsx:30-88`, drawn
 * anew): a robot head on one of Orca's picture backgrounds. A picked face is saved as a PNG in the bot's folder like an
 * uploaded picture (`rasterizePicture`), so the core keeps one kind of picture. Pictures, not surfaces: their colours
 * are the picture's own and do not follow the theme.
 */

/** Orca's picture backgrounds (Sky, Lavender, Pink, Peach, Butter, Sage, Mint, Slate). */
const BACKGROUNDS = ["#cfe8ff", "#e4dcff", "#ffd9e8", "#ffe0c7", "#fff1b8", "#dbe8cf", "#c9f2e3", "#d6dde6"];
const INK = "#1f2430";

/** Eyes: round, wide, sleepy, happy arcs. */
const EYES = [
	'<circle cx="40" cy="52" r="6"/><circle cx="64" cy="52" r="6"/>',
	'<rect x="33" y="46" width="14" height="12" rx="3"/><rect x="57" y="46" width="14" height="12" rx="3"/>',
	'<rect x="33" y="51" width="14" height="4" rx="2"/><rect x="57" y="51" width="14" height="4" rx="2"/>',
	'<path d="M33 55q7-9 14 0M57 55q7-9 14 0" fill="none" stroke="#1f2430" stroke-width="4" stroke-linecap="round"/>',
];
/** Mouths: smile, flat, open. */
const MOUTHS = [
	'<path d="M42 68q10 8 20 0" fill="none" stroke="#1f2430" stroke-width="4" stroke-linecap="round"/>',
	'<rect x="42" y="66" width="20" height="4" rx="2"/>',
	'<rect x="45" y="64" width="14" height="9" rx="4"/>',
];

export const BOT_MASCOT_COUNT = BACKGROUNDS.length * 2;

/** Face `index` (0 to `BOT_MASCOT_COUNT - 1`) as an SVG document. */
export function mascotSvg(index: number): string {
	const n = ((index % BOT_MASCOT_COUNT) + BOT_MASCOT_COUNT) % BOT_MASCOT_COUNT;
	const background = BACKGROUNDS[n % BACKGROUNDS.length];
	const eyes = EYES[n % EYES.length];
	const mouth = MOUTHS[(n >> 1) % MOUTHS.length];
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 104 104"><rect width="104" height="104" fill="${background}"/><line x1="52" y1="16" x2="52" y2="28" stroke="${INK}" stroke-width="4" stroke-linecap="round"/><circle cx="52" cy="14" r="5" fill="${INK}"/><rect x="20" y="28" width="64" height="58" rx="18" fill="#ffffff" stroke="${INK}" stroke-width="4"/><g fill="${INK}">${eyes}${mouth}</g></svg>`;
}

/** Face `index` as a `data:` URI an `<img>` shows. */
export function mascotUri(index: number): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mascotSvg(index))}`;
}

/** The longest side a saved picture keeps: enough for every place a bot's face shows, small enough for the state. */
export const PICTURE_SIDE = 192;

/**
 * Any picture the person picked (a face, an uploaded or pasted image file) as a square PNG `data:` URI of
 * `PICTURE_SIDE` pixels, cropped to its middle: what the core saves as `picture.png`.
 */
export async function rasterizePicture(picked: string | Blob): Promise<string> {
	const src = typeof picked === "string" ? picked : URL.createObjectURL(picked);
	try {
		return await squarePng(src);
	} finally {
		if (typeof picked !== "string") URL.revokeObjectURL(src);
	}
}

async function squarePng(src: string): Promise<string> {
	const image = new Image();
	image.decoding = "async";
	image.src = src;
	await image.decode();
	const side = Math.min(image.naturalWidth || PICTURE_SIDE, image.naturalHeight || PICTURE_SIDE);
	const canvas = document.createElement("canvas");
	canvas.width = PICTURE_SIDE;
	canvas.height = PICTURE_SIDE;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("No canvas");
	const sx = ((image.naturalWidth || side) - side) / 2;
	const sy = ((image.naturalHeight || side) - side) / 2;
	context.drawImage(image, sx, sy, side, side, 0, 0, PICTURE_SIDE, PICTURE_SIDE);
	return canvas.toDataURL("image/png");
}
