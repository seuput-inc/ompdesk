/**
 * Where a spotlight's control is (Spotlight.tsx). Its own module because a surface's first-visit check
 * (surface-tours.ts, on the first screen) asks it before any tour's card, which loads as its own chunk.
 */

/** Room around the control inside the hole. */
export const PAD = 6;

export interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** The first of `targets` on screen, padded; null when none is. */
export function measureTarget(targets: readonly string[]): Box | null {
	for (const selector of targets) {
		const node = document.querySelector(selector);
		if (!node) continue;
		const rect = node.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) {
			return {
				left: rect.left - PAD,
				top: rect.top - PAD,
				width: rect.width + PAD * 2,
				height: rect.height + PAD * 2,
			};
		}
	}
	return null;
}
