/** A decorative 16px repository mark. Missing, refused and failed images keep the same box and generic glyph. */
import { FolderGit2 } from "lucide-react";
import { useState } from "react";
import type { RepoImage } from "../../../shared/repo-images";

export function RepositoryImage({ image }: { image?: RepoImage | null }) {
	const [failed, setFailed] = useState<string>();
	const source = image?.dataUrl;
	const valid = source && source.length <= 33_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source);
	return (
		<span
			aria-hidden
			className="inline-flex size-4 shrink-0 items-center justify-center"
			data-repository-image={valid && failed !== source ? image?.source : "generic"}
		>
			{valid && failed !== source ? (
				<img
					alt=""
					className="size-4 rounded-sm object-contain"
					decoding="async"
					draggable={false}
					height={16}
					onError={() => setFailed(source)}
					src={source}
					width={16}
				/>
			) : (
				<FolderGit2 className="size-4 text-(--sc-text-subtle)" />
			)}
		</span>
	);
}
