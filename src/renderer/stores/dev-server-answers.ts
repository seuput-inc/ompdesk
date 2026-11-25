/**
 * Local dev servers, by origin, whose last Preview load was refused (Orca's evicted dev-server URL, 25 Nov 2026): the
 * bash card's "Open Preview" link then says the server stopped instead of offering a page that is gone. A later load
 * of the same origin that answers clears it. Kept per window, never saved.
 */
import { create } from "zustand";

interface DevServerAnswersState {
	refused: Readonly<Record<string, true>>;
	reset: () => void;
}

export const useDevServerAnswers = create<DevServerAnswersState>(set => ({
	refused: {},
	reset: () => set({ refused: {} }),
}));

/** Chromium's net errors that mean nothing listens on the port any more (a slow or failing page is not one). */
const GONE = /\bERR_(?:CONNECTION_REFUSED|ADDRESS_UNREACHABLE|EMPTY_RESPONSE|CONNECTION_RESET)\b/;

export function devServerOrigin(url: string): string | null {
	try {
		return new URL(url).origin;
	} catch {
		return null;
	}
}

/** What the Preview's page just did: `error` is its failed load's description, null for a page that loaded. */
export function noteDevServerLoad(url: string, error: string | null): void {
	const origin = devServerOrigin(url);
	if (!origin) return;
	const gone = error !== null && GONE.test(error);
	const { refused } = useDevServerAnswers.getState();
	if (gone === Boolean(refused[origin])) return;
	if (gone) {
		useDevServerAnswers.setState({ refused: { ...refused, [origin]: true } });
		return;
	}
	const { [origin]: _answered, ...rest } = refused;
	useDevServerAnswers.setState({ refused: rest });
}
