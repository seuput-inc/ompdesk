import { useEffect } from "react";
import { projectMetadataKey, useProjectMetadata } from "../../../stores/project-metadata";
import { RepositoryImage } from "../../common";

/** Multiple selected targets have no single repository identity. Never choose the first target's image. */
export function SidebarRepositoryImage({ paths, device }: { paths: readonly string[]; device?: string }) {
	const path = paths.length === 1 ? paths[0] : undefined;
	const metadata = useProjectMetadata(state => (path ? state.entries[projectMetadataKey(path, device)] : undefined));
	useEffect(() => {
		if (path) useProjectMetadata.getState().request([path], device);
	}, [path, device]);
	return <RepositoryImage image={metadata?.repository ? metadata.image : null} />;
}
