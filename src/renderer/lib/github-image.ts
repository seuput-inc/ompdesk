/**
 * A pasted or dropped image uploaded as a GitHub attachment for a Markdown box (Orca `use-github-image-uploads.ts`):
 * the type and size GitHub takes are checked here, the upload is the core's `image_upload` (gh on the tab's machine).
 * A private attachment shown back is fetched once per URL as a `data:` URL (`attachment`), since the page never loads
 * a remote image itself.
 */
import { useEffect, useState } from "react";
import {
	GITHUB_IMAGE_MAX_BYTES,
	GITHUB_IMAGE_TYPES,
	type GithubImageMap,
	type GithubImageType,
	type GithubTarget,
} from "../../shared/github";
import { toastError } from "../stores/toast";
import { github } from "./github";
import { translate } from "./i18n";

/** The file's bytes as base64. */
async function base64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

/** Uploads `file` and answers its URL, or null after telling why it could not. */
export async function uploadGithubImage(file: File, target: GithubTarget = {}): Promise<string | null> {
	const type = GITHUB_IMAGE_TYPES.find(known => known === file.type) as GithubImageType | undefined;
	if (!type) {
		toastError({ title: translate("githubImage.failed"), error: translate("githubImage.type") });
		return null;
	}
	if (file.size === 0 || file.size > GITHUB_IMAGE_MAX_BYTES) {
		toastError({ title: translate("githubImage.failed"), error: translate("githubImage.size") });
		return null;
	}
	try {
		const { url } = await github({
			op: "image_upload",
			name: file.name || "image",
			contentType: type,
			data: await base64(file),
			...target,
		});
		return url;
	} catch (error) {
		toastError({ title: translate("githubImage.failed"), error });
		return null;
	}
}

/** One read per signed URL for the window's life. */
const shown = new Map<string, Promise<string>>();

/**
 * `body` with each private attachment (`images`: its URL as written → the signed URL) replaced by its picture as a
 * `data:` URL once read; until then, and when a read fails, the body as written (its images show as links).
 */
export function useGithubImages(body: string, images: GithubImageMap | undefined): string {
	const [read, setRead] = useState<Record<string, string>>({});
	const signature = images ? JSON.stringify(images) : "";
	useEffect(() => {
		if (!signature) return;
		let live = true;
		for (const [original, signed] of Object.entries(JSON.parse(signature) as GithubImageMap)) {
			let pending = shown.get(signed);
			if (!pending) {
				pending = github({ op: "attachment", url: signed }).then(answer => answer.dataUrl);
				pending.catch(() => shown.delete(signed));
				shown.set(signed, pending);
			}
			pending.then(
				dataUrl => live && setRead(current => ({ ...current, [original]: dataUrl })),
				() => undefined,
			);
		}
		return () => {
			live = false;
		};
	}, [signature]);
	let text = body;
	for (const [original, dataUrl] of Object.entries(read)) text = text.split(original).join(dataUrl);
	return text;
}
