/**
 * The agent's `models.yml`: the Settings page's providers, their edits and the in-app text editor. The core owns the
 * file (`native/ompdesk/crates/core/src/models/file`): it edits the YAML in place so comments and layout survive, has
 * stock parse and normalize every text it reads or writes, runs one edit at a time and writes atomically. This module
 * hands it the agent folder and the stock helper's lanes.
 */
import { codedError, isIpcErrorCode } from "../shared/ipc-error-codes";
import type {
	CustomProviderInput,
	CustomProviderModelInput,
	CustomProvidersConfig,
	CustomProviderView,
	ModelOverrideInput,
} from "../shared/ipc-types";
import { agentDir } from "./agent-paths";
import { CoreError, core } from "./core/process";
import { stockHelperHost } from "./stock-helper";

export type { CustomProviderInput, CustomProviderModelInput, CustomProviderView };

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	try {
		const { result } = await core().call(method, { dir: agentDir(), host: stockHelperHost(), ...params });
		return result as T;
	} catch (error) {
		// A refusal the page shows in its own words keeps its code; the rest are plain errors with their reason.
		if (!(error instanceof CoreError)) throw error;
		throw isIpcErrorCode(error.code) ? codedError(error.code, error.message) : new Error(error.message);
	}
}

/** The models file (`models.yml`, or `models.yaml` while only that exists); `create` writes a skeleton when missing. */
export async function modelsPath(options: { create?: boolean } = {}): Promise<string> {
	return (await call<{ path: string }>("models.path", { create: options.create === true })).path;
}

/** Configured providers (custom ones and overrides of built-ins), keys masked, with the form's option vocabularies
 * from the installed omp. */
export function modelsCatalog(): Promise<CustomProvidersConfig> {
	return call("models.list");
}

export async function listModelsProviders(): Promise<CustomProviderView[]> {
	return (await modelsCatalog()).providers;
}

/** Insert or update a custom provider. Keeps the stored apiKey unless the input re-supplies one or sets `clearApiKey`. */
export async function upsertModelsProvider({ onlyIfAbsent, ...input }: CustomProviderInput): Promise<void> {
	const wrote = await call<boolean>("models.upsert", { input, onlyIfAbsent });
	if (!wrote && onlyIfAbsent) throw codedError("changed_on_disk", "Provider already exists");
}

/** Delete a custom provider entry (built-ins cannot be removed here). */
export async function deleteModelsProvider(id: string): Promise<void> {
	await call("models.delete", { id });
}

/** Write (or with `null`, remove) one model's `modelOverrides` entry under any provider, built-in ones included. */
export async function setModelOverride(
	provider: string,
	modelId: string,
	input: ModelOverrideInput | null,
): Promise<void> {
	await call("models.override", { provider, model: modelId, input });
}

/** What an in-app editor needs of the models file. */
export interface ModelsText {
	path: string;
	/** The file, or a minimal skeleton while it does not exist. */
	text: string;
	exists: boolean;
	/** Identifies the file as read; `writeModelsText` refuses when it changed since. */
	stamp: string;
}

export function readModelsText(): Promise<ModelsText> {
	return call("models.text");
}

/**
 * Save text an editor produced, through the same checks as every GUI edit: stock's parser and schema check it first
 * (an invalid file is never written, the reason comes back as `invalid_content`), the swap is atomic, and a file that
 * changed on disk since `stamp` was read is not overwritten. Resolves the new stamp.
 */
export function writeModelsText(text: string, stamp: string): Promise<string> {
	return call("models.saveText", { text, stamp });
}
