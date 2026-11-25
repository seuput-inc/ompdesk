/**
 * OMPdesk's A2UI catalog as web_core runs it: the one catalog document the bridge validates against
 * (`resources/gui-bridge/modes/a2ui-catalog.json`), with web_core's own implementations of the basic
 * functions it declares (docs/design/a2ui.md §2). `openUrl` opens http(s) only, through `openExternal`.
 */

import { Catalog, createFunctionImplementation, type FunctionImplementation } from "@a2ui/web_core";
import { createBasicCatalogFunctions } from "@a2ui/web_core/catalogs/basic/v1";
import catalogDocument from "../../../../resources/gui-bridge/modes/a2ui-catalog.json";
import { openExternal } from "../open-external";

/** Builds the catalog for one session; `locale` formats numbers, dates and plurals. */
export function createA2uiCatalog(locale: string, openUrl: (url: string) => void = openExternal): Catalog<never> {
	const declared = Catalog.fromJson(catalogDocument);
	const basic = new Map(createBasicCatalogFunctions({ locale }).map(fn => [fn.name, fn]));
	const functions: FunctionImplementation[] = [...declared.functions.values()].map(api => {
		if (api.name === "openUrl") {
			return createFunctionImplementation(api, (args: { url?: unknown }) => {
				if (typeof args.url === "string" && /^https?:\/\//i.test(args.url)) openUrl(args.url);
			});
		}
		const execute = basic.get(api.name)?.execute;
		// A declared function the renderer cannot run would fall back to the agent; the catalog may only name ours.
		if (!execute) throw new Error(`a2ui catalog declares '${api.name}', which web_core does not implement`);
		return createFunctionImplementation(api, execute);
	});
	return declared.withEntries([...declared.components.values()], functions) as Catalog<never>;
}
