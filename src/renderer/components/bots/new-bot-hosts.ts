import { BOT_CREATE_REFUSED } from "../../../shared/bots";
import type { HostView } from "../../../shared/ipc-types";

export type HostState = "ready" | "offline" | "update" | "busy";
export interface BotHostRow {
	device: string | null;
	name: string;
	platform?: string;
	state: HostState;
	reason: HostState | "checking" | "connecting";
}

export function botHostRows(
	local: { name: string; platform?: string },
	hosts: readonly HostView[],
	probes: ReadonlyMap<string, HostState>,
	disconnected: boolean,
	origin?: string | null,
	selected = origin,
): BotHostRow[] {
	const rows: BotHostRow[] = [];
	const add = (device: string | null, name: string, platform: string | undefined, link: HostView["state"]) => {
		if (origin !== undefined && device !== origin) return;
		const reason =
			disconnected || link === "offline"
				? "offline"
				: link === "connecting"
					? "connecting"
					: (probes.get(device ?? "") ?? "checking");
		rows.push({
			device,
			name,
			platform,
			reason,
			state: reason === "connecting" || reason === "checking" ? "busy" : reason,
		});
	};
	add(null, local.name, local.platform, "online");
	for (const host of hosts) add(host.deviceId, host.name, host.platform, host.state);
	if (selected && !rows.some(row => row.device === selected)) add(selected, selected, undefined, "offline");
	return rows.sort((a, b) => Number(b.state === "ready") - Number(a.state === "ready"));
}

export function failedHostProbe(error: unknown): HostState {
	const message = error instanceof Error ? error.message : String(error);
	if (/offline|disconnected|not connected/i.test(message)) return "offline";
	return /unknown (?:action|command|method)|unsupported|not supported|cannot createFolder|not implemented/i.test(
		message,
	)
		? "update"
		: "busy";
}

/** An explicit refusal is different from losing the reply after the computer may have saved the bot. */
export function botCreateFailure(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const at = message.indexOf(BOT_CREATE_REFUSED);
	const detail = at < 0 ? message : message.slice(at + BOT_CREATE_REFUSED.length);
	if (
		/cannot create the bots of this computer|unknown (?:action|command|method).*create|unsupported.*(?:create|routines)/i.test(
			detail,
		)
	)
		return { kind: "update", detail } as const;
	if (/already a bot named/i.test(detail)) return { kind: "name", detail } as const;
	if (/request limit for today/i.test(detail)) return { kind: "requests", detail } as const;
	if (/token limit for today/i.test(detail)) return { kind: "tokens", detail } as const;
	if (/\[remote_limit_reached\]/.test(detail)) return { kind: "limit", detail } as const;
	if (/offline|disconnected|not connected/i.test(detail)) return { kind: "offline", detail } as const;
	return { kind: at < 0 ? "unconfirmed" : "refused", detail } as const;
}
