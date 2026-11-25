/**
 * Main-side worker: a picture a paired phone sent in a format models refuse (HEIC/HEIF, an iPhone camera's
 * default) made model-safe with stock's own image path, which needs Bun (`Bun.Image`): stock
 * `ensureSupportedImageInput` (the TUI's pasted-image conversion) and then `resizeImage`, as
 * `InputController#normalizePastedImage` runs them. Stock keeps a small picture as PNG and re-encodes a camera
 * sized one, usually to JPEG.
 */
import { ompModuleFile } from "../omp-package";

interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

function imageBlock(params: unknown): ImageBlock {
	if (typeof params !== "object" || params === null) throw new Error("An image is required");
	const data = "data" in params ? params.data : undefined;
	const mimeType = "mimeType" in params ? params.mimeType : undefined;
	if (typeof data !== "string" || typeof mimeType !== "string") throw new Error("An image is required");
	return { type: "image", data, mimeType };
}

async function stockImageModules() {
	// Runtime-selected: the image path belongs to the user's resolved omp installation.
	const [loading, resize] = await Promise.all([
		import(ompModuleFile("pi-tui/chat/image-loading")),
		import(ompModuleFile("pi-coding-agent/utils/image-resize")),
	]);
	if (typeof loading.ensureSupportedImageInput !== "function" || typeof resize.resizeImage !== "function") {
		throw new Error("Installed omp has no image conversion");
	}
	return {
		ensureSupported: loading.ensureSupportedImageInput as (image: ImageBlock) => Promise<ImageBlock | null>,
		resizeImage: resize.resizeImage as (
			image: ImageBlock,
			options: { excludeWebP: boolean },
		) => Promise<{ data: string; mimeType: string }>,
	};
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	"image.toModel": async params => {
		const { ensureSupported, resizeImage } = await stockImageModules();
		const supported = await ensureSupported(imageBlock(params));
		if (!supported) throw new Error("This picture could not be read");
		const resized = await resizeImage(supported, { excludeWebP: true });
		return { type: "image", data: resized.data, mimeType: resized.mimeType };
	},
};
