import sharp from "sharp";

/** Preserve the premultiplied BGRA thresholds used by the screen and Preview capture checks. */
export async function screenshotBitmap(png: Buffer | string): Promise<Buffer> {
	const pixels = await sharp(png).toColourspace("srgb").ensureAlpha().raw().toBuffer();
	for (let i = 0; i < pixels.length; i += 4) {
		const scale = pixels[i + 3] / 255;
		const red = pixels[i];
		pixels[i] = Math.round(pixels[i + 2] * scale);
		pixels[i + 1] = Math.round(pixels[i + 1] * scale);
		pixels[i + 2] = Math.round(red * scale);
	}
	return pixels;
}
