/**
 * ProjectArtwork — the picture of the repository a row works in: the repository's own image (its favicon or social
 * thumbnail), else its owner's avatar, both as `src`; with no `src`, or one that fails to load, a letter mark (the
 * name's first letter on a wash of a hue picked from the name, the same on every computer and every launch). `icon`
 * draws a glyph on a neutral wash instead, for a row that works in no repository (a chat).
 * Decorative: the row names the repository in words (its tooltip, its accessible text). `size` in px; the sidebar's
 * session row draws it 32 px, spanning the row's two lines.
 */
import { type ReactNode, useState } from "react";
import { hueOf } from "../../lib/device-color";
import { cx } from "../../lib/format";

export interface ProjectArtworkProps {
	/** The repository's name (the letter mark's letter and hue). */
	name: string;
	/** A picture that loads inside every view, the phone's page included: a `data:` URI or a URL the app serves. */
	src?: string | null;
	/** A glyph on a neutral wash in place of picture and letter (a chat, which works in no repository). */
	icon?: ReactNode;
	size?: number;
	className?: string;
}

/** The name's first letter (a whole grapheme, so "한" and an emoji stay whole), upper-cased; "?" for an empty name. */
export function artworkLetter(name: string): string {
	const trimmed = name.replace(/^[^\p{L}\p{N}]+/u, "");
	const first = trimmed ? [...new Intl.Segmenter().segment(trimmed)][0]?.segment : undefined;
	return first ? first.toLocaleUpperCase() : "?";
}

export function ProjectArtwork({ name, src, icon, size = 32, className }: ProjectArtworkProps) {
	// Only the picture that failed falls back: a new `src` gets its own try.
	const [failed, setFailed] = useState<string | null>(null);
	const image = !icon && src && failed !== src ? src : null;
	const kind = icon ? "icon" : image ? "image" : "letter";
	return (
		<span
			aria-hidden
			className={cx(
				"omp-project-artwork inline-flex shrink-0 items-center justify-center overflow-hidden rounded-(--sc-radius-md) select-none",
				className,
			)}
			data-project-artwork={kind}
			data-mark-hue={kind === "letter" ? hueOf(name) : undefined}
			style={{ width: size, height: size, fontSize: Math.round(size * 0.47) }}
		>
			{image ? (
				<img
					alt=""
					className="size-full object-cover"
					decoding="async"
					draggable={false}
					height={size}
					loading="lazy"
					onError={() => setFailed(image)}
					src={image}
					width={size}
				/>
			) : (
				(icon ?? artworkLetter(name))
			)}
		</span>
	);
}
