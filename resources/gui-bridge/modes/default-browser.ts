/**
 * Default browser (rules and text: default-browser-core.ts): the per-turn section that points agents at ego-browser
 * or says the picked browser cannot be verified, and the `browser.enabled` override that holds the built-in `browser`
 * tool off for the latter. Registered like the other OMPdesk sections (../prompt-sections.ts), so the context
 * inspector shows it too.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "../health";
import { overridable } from "../settings-override";
import {
	applyDefaultBrowser,
	type BrowserSetting,
	install as installPrompt,
	previewRelayStarted as previewRelayStartedCore,
	previewRelayStopped as previewRelayStoppedCore,
	setDefaultBrowser,
} from "./default-browser-core";

export function install(pi: ExtensionAPI): void {
	applyDefaultBrowser(pi.pi.Settings.instance, browserSetting());
	installPrompt(pi);
}

export function previewRelayStarted(scope: object): void {
	previewRelayStartedCore(scope, browserSetting());
}

function browserSetting(): BrowserSetting {
	const enabled = overridable("browser.enabled");
	return {
		block: scope => enabled.override(scope, false),
		unblock: scope => enabled.clearOverride(scope),
	};
}

/** Preview's agent browsing stopped (browser-relay.ts) and cleared its overrides: hold the default browser's again. */
export function previewRelayStopped(scope: object): void {
	previewRelayStoppedCore(scope, browserSetting());
}

export const methods = guard("defaultBrowser", {
	/** Main sends this to every live local sidecar when the setting changes, and on bridge connect. */
	default_browser_set: async (params, env) => {
		const result = setDefaultBrowser(params);
		applyDefaultBrowser(env.session().settings as unknown as object, browserSetting());
		return result;
	},
});
