import { isAbsolute } from "node:path";
import { PROJECT_METADATA_BATCH, type ProjectMetadataBatch } from "../shared/project-metadata";
import { coreGit } from "./local/git/exec";

/** Only the execution host reads repository metadata or makes a public image request. */
export function readProjectMetadata(paths: readonly string[]): Promise<ProjectMetadataBatch> {
	if (paths.length > PROJECT_METADATA_BATCH || paths.some(path => !isAbsolute(path) || path.length > 4096)) {
		return Promise.reject(new Error("Project metadata needs at most 24 absolute checkout paths"));
	}
	return coreGit<ProjectMetadataBatch>("projectMetadata.get", { paths: [...new Set(paths)] }, 0, 120_000);
}
