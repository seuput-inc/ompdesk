/**
 * What an image's right-click menu does with the picture it shows: copy it to
 * the clipboard, or save it where the user picks. Both work from the `src` the
 * page already holds (a data: or blob: URL, or a local media URL).
 */

/** Chromium's async clipboard writes PNG only; anything else is re-encoded. */
async function asPng(blob: Blob): Promise<Blob> {
	if (blob.type === "image/png") return blob;
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
		return await canvas.convertToBlob({ type: "image/png" });
	} finally {
		bitmap.close();
	}
}

export async function copyImage(src: string): Promise<void> {
	const blob = await (await fetch(src)).blob();
	const png = await asPng(blob);
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/**
 * Copy a picture the page holds. Call it inside the click: the write starts there with the PNG still being made
 * (a `ClipboardItem` of a promise), so WebKit keeps the gesture.
 */
export function copyImageBlob(blob: Blob): Promise<void> {
	return navigator.clipboard.write([new ClipboardItem({ "image/png": asPng(blob) })]);
}

/**
 * The picture scaled down until its PNG fits `maxBytes` (a screenshot keeps its look, only its size shrinks), or null
 * when four ever smaller tries do not fit. Orca: sidebar-feedback/feedback-image-shrink.ts:20, which keeps the
 * resolution and refuses instead; GitHub's 10 MB picture limit makes a smaller picture the better outcome here.
 */
export async function shrinkImage(blob: Blob, maxBytes: number): Promise<Blob | null> {
	const bitmap = await createImageBitmap(blob);
	try {
		let scale = Math.min(1, Math.sqrt(maxBytes / blob.size));
		for (let attempt = 0; attempt < 4; attempt++) {
			const width = Math.max(1, Math.round(bitmap.width * scale));
			const height = Math.max(1, Math.round(bitmap.height * scale));
			const canvas = new OffscreenCanvas(width, height);
			canvas.getContext("2d")?.drawImage(bitmap, 0, 0, width, height);
			const png = await canvas.convertToBlob({ type: "image/png" });
			if (png.size <= maxBytes) return png;
			scale *= 0.7;
		}
		return null;
	} finally {
		bitmap.close();
	}
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** `saved` is false when the user cancelled the dialog. */
export async function saveImage(src: string, name: string): Promise<{ saved: boolean; error?: string }> {
	const blob = await (await fetch(src)).blob();
	const type = blob.type || "image/png";
	return window.omp.system.saveImage(name, type, bytesToBase64(new Uint8Array(await blob.arrayBuffer())));
}
