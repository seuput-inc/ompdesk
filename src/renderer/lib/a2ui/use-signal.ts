/** React's view of a web_core signal (a node's props, a surface's root): re-renders when the signal changes. */

import { effect, getValue, peekValue, type Signal } from "@a2ui/web_core";
import { useCallback, useSyncExternalStore } from "react";

export function useSignal<T>(signal: Signal<T>): T {
	const subscribe = useCallback(
		(changed: () => void) =>
			effect(() => {
				getValue(signal);
				changed();
			}),
		[signal],
	);
	return useSyncExternalStore(subscribe, () => peekValue(signal));
}
