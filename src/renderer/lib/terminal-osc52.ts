/**
 * OSC 52 ("Manipulate Selection Data"): a program in the terminal (tmux, Neovim, Zellij, an SSH session) copies text
 * to this device's clipboard. xterm.js leaves it to its embedder. Ported from Orca's
 * `shared/terminal/clipboard/osc52-clipboard.ts` (MIT, see THIRD_PARTY_NOTICES.txt):
 * - writes only: a query (`?`) is ignored, so nothing writing to the PTY can read the clipboard;
 * - the payload is capped (128 K base64 characters) and an empty one (xterm's clear-selection) is refused;
 * - output replayed from the kept scrollback (a viewer catching up, a screen rebuilt) never copies, or an old copy
 *   would overwrite a newer clipboard;
 * - writes arriving in one parse burst collapse to the last one.
 * On, with no setting, as kitty and Ghostty ship it.
 */
export type Osc52Parse =
	| { kind: "write"; text: string }
	| { kind: "query" }
	| { kind: "invalid"; reason: "separator" | "selection" | "size" | "base64" | "empty" };

const MAX_BASE64 = 128 * 1024;

export function parseOsc52(data: string): Osc52Parse {
	const semi = data.indexOf(";");
	if (semi === -1) return { kind: "invalid", reason: "separator" };
	// tmux sends an empty selection; every kind lands on the one clipboard.
	const selections = data.slice(0, semi) || "c";
	const payload = data.slice(semi + 1);
	if (!/^[cpqs0-7]+$/.test(selections)) return { kind: "invalid", reason: "selection" };
	if (payload === "?") return { kind: "query" };
	if (payload.length > MAX_BASE64) return { kind: "invalid", reason: "size" };
	// Line-wrapped base64 from a TUI is fine; any other byte outside the alphabet is not.
	const stripped = payload.replace(/[\t\n\v\f\r ]/g, "");
	if (!/^[A-Za-z0-9+/=]*$/.test(stripped)) return { kind: "invalid", reason: "base64" };
	let text: string;
	try {
		const binary = atob(stripped);
		text = new TextDecoder("utf-8").decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
	} catch {
		return { kind: "invalid", reason: "base64" };
	}
	return text ? { kind: "write", text } : { kind: "invalid", reason: "empty" };
}

/** xterm's OSC 52 handler: always claims the sequence, writes the clipboard only for a live write. */
export function osc52Handler(deps: {
	replaying: () => boolean;
	write: (text: string) => Promise<void>;
	onFailure: () => void;
}): (data: string) => boolean {
	let pending: string | null = null;
	return data => {
		const parsed = parseOsc52(data);
		if (parsed.kind !== "write" || deps.replaying()) return true;
		const scheduled = pending !== null;
		pending = parsed.text;
		if (!scheduled)
			queueMicrotask(() => {
				const text = pending;
				pending = null;
				if (text === null) return;
				try {
					deps.write(text).catch(deps.onFailure);
				} catch {
					deps.onFailure();
				}
			});
		return true;
	};
}
