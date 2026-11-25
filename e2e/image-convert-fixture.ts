/// <reference types="bun" />
/**
 * The fake omp package's stand-ins for stock's image path (`pi-coding-agent/utils/image-input` `ensureSupportedImageInput`
 * and `pi-coding-agent/utils/image-resize` `resizeImage`), which the stock helper's `image.toModel` runs on a
 * phone's HEIC. Stock decodes with `Bun.Image`, which reads a HEIC only through the OS (ImageIO on macOS; WIC on
 * Windows, where it needs the Store's "HEIF Image Extensions", absent on a runner), so the decode is not what
 * the e2e asserts: a HEIC here answers `photo-heic-as-jpeg.jpg`, the same picture converted once with `sips` (a fixed
 * file, no codec at run time). Everything else decodes with `Bun.Image` as stock does; this always answers a JPEG.
 */
interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const HEIF = new Set(["image/heic", "image/heif"]);

export async function ensureSupportedImageInput(image: ImageBlock): Promise<ImageBlock | null> {
	if (SUPPORTED.has(image.mimeType)) return image;
	if (HEIF.has(image.mimeType)) {
		const jpeg = await Bun.file(new URL("./media/photo-heic-as-jpeg.jpg", import.meta.url)).bytes();
		return { type: "image", data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };
	}
	const png = await new Bun.Image(Buffer.from(image.data, "base64")).png().bytes();
	return { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" };
}

export async function resizeImage(image: ImageBlock): Promise<{ data: string; mimeType: string }> {
	const jpeg = await new Bun.Image(Buffer.from(image.data, "base64")).jpeg().bytes();
	return { data: Buffer.from(jpeg).toString("base64"), mimeType: "image/jpeg" };
}
