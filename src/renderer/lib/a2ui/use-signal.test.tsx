import { type Signal, setValue, signal } from "@a2ui/web_core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { useSignal } from "./use-signal";

const { document, window } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, IS_REACT_ACT_ENVIRONMENT: true });

function Count({ value }: { value: Signal<number> }) {
	return <span>{useSignal(value)}</span>;
}

describe("useSignal", () => {
	it("re-renders on each change of the signal and stops listening once unmounted", async () => {
		const value = signal(1);
		const container = document.createElement("div");
		const root = createRoot(container as unknown as Element);
		await act(async () => root.render(<Count value={value} />));
		expect(container.textContent).toBe("1");
		await act(async () => setValue(value, 2));
		expect(container.textContent).toBe("2");
		await act(async () => root.unmount());
		setValue(value, 3);
		expect(container.textContent).toBe("");
	});
});
