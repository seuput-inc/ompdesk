/**
 * A paired host tab's dev servers in this computer's Preview (`preview.hostPort`, main's remote/port-tunnels.ts): each
 * opens through a stand-in on this computer's loopback. A host tab's Preview opens those addresses and no other
 * loopback one, since anything else on this computer's loopback is not the tab's.
 */
import { isLoopbackUrl } from "../../shared/preview";

/** The stand-ins' `host:port`s handed out on this page. */
const standIns = new Set<string>();

/** The address here that shows the host tab `tabId`'s server on `port`. */
export async function hostPortUrl(tabId: string, port: number): Promise<string> {
	const url = await window.omp.preview.hostPort(tabId, port);
	standIns.add(new URL(url).host);
	return url;
}

/** Whether a paired host's tab may not open `url` here: a loopback address other than one of its stand-ins. */
export function hostTabCannotOpen(url: string): boolean {
	if (!isLoopbackUrl(url)) return false;
	return !URL.canParse(url) || !standIns.has(new URL(url).host);
}
