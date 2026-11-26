import type { RemoteTailnetPhase } from "./ipc-types";

/**
 * How long a link to the computer must stay down before any surface says so (the title bar's status turning to
 * "Reconnecting…", on a phone's page and for a desktop tab of a paired host). A drop that heals inside it shows
 * nothing.
 *
 * 3 s, from `e2e/phone-reconnect.e2e.ts` (2 Nov 2026): the page retries at once, then after 0.25, 0.5 and 1 s and every
 * second after (`ws-transport.ts` `RETRY_MS`), so a network that is gone for 2 s is back on the socket by about 2.5 s
 * (measured 2.54 s from the cut, a message sent meanwhile); a blip is back in 12-130 ms, a short outage 0.1-0.2 s after
 * the network. The desktop's first retry is 1 s (`main/remote/client.ts` `RECONNECT_MIN_MS`) plus a tailnet dial and
 * handshake. A phone page returning from the background and an app start or window reload therefore stay silent,
 * while an outage that outlasts a couple of retries shows within 3 s and stays until the link is back.
 */
export const LINK_NOTICE_GRACE_MS = 3000;

/**
 * How long a paired host must stay out of reach before its offline line asks the person to check Tailscale, when this
 * computer's own Tailscale also reads down. A minute past the grace: the core's tailnet poll (15 s) wakes every host
 * as soon as Tailscale is back (`wake_returned_hosts`), and a Tailscale that restarts on wake or a host app restart
 * (`REFUSED_RETRY_WINDOW_MS`, 60 s) heals inside it, so the hint names only an outage that stays.
 */
export const TAILSCALE_HINT_AFTER_MS = LINK_NOTICE_GRACE_MS + 60_000;

/**
 * Whether a paired host's offline line adds "Check that Tailscale is on": the host has been down since `downSince`
 * (undefined while online) for `TAILSCALE_HINT_AFTER_MS`, and this computer's tailnet is known and not ready. With the
 * tailnet up the host itself is off, which the offline line already says.
 */
export function tailscaleHint(
	downSince: number | undefined,
	tailnet: RemoteTailnetPhase | undefined,
	now: number,
): boolean {
	return (
		downSince !== undefined &&
		tailnet !== undefined &&
		tailnet !== "ready" &&
		now - downSince >= TAILSCALE_HINT_AFTER_MS
	);
}
