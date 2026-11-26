import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewDevice, PreviewDeviceRequest } from "../../../shared/preview";
import { I18nProvider } from "../../lib/i18n";
import { PreviewDeviceScreen } from "./PreviewDevice";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let root: Root | undefined;

function deviceApi() {
	const device = vi.fn(async (request: PreviewDeviceRequest) => (request.action === "screen" ? "iVBORw0K" : null));
	Object.assign(window, { omp: { preview: { device } } });
	return device;
}

async function mount(device: PreviewDevice) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	const created = root;
	await act(async () =>
		created.render(
			<I18nProvider>
				<PreviewDeviceScreen active device={device} onClose={() => {}} />
			</I18nProvider>,
		),
	);
}

afterEach(async () => {
	const mounted = root;
	root = undefined;
	if (mounted) await act(async () => mounted.unmount());
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("a running device's screen in the Preview", () => {
	it("shows an Android screen, taps at the pixel clicked and sends its keys", async () => {
		const device = deviceApi();
		await mount({ platform: "android", id: "emulator-5554", name: "Pixel 8" });
		expect(device).toHaveBeenCalledWith({ action: "screen", platform: "android", id: "emulator-5554" });
		const screen = document.querySelector('img[alt="Pixel 8\'s screen"]') as unknown as Record<string, unknown>;
		expect(screen).not.toBeNull();
		// Shown at 270 x 600, the picture's own pixels are 1080 x 2400: a click maps to the device's pixel.
		Object.assign(screen, {
			naturalWidth: 1080,
			naturalHeight: 2400,
			getBoundingClientRect: () => ({ left: 10, top: 20, width: 270, height: 600 }),
		});
		const propsKey = Object.getOwnPropertyNames(screen).find(key => key.startsWith("__reactProps$"));
		const props = screen[propsKey ?? ""] as { onClick?: (event: object) => void };
		await act(async () => props.onClick?.({ currentTarget: screen, clientX: 145, clientY: 320 }));
		expect(device).toHaveBeenCalledWith({ action: "tap", id: "emulator-5554", x: 540, y: 1200 });
		const back = document.querySelector('button[aria-label="Back"]') as unknown as { click: () => void };
		await act(async () => back.click());
		expect(device).toHaveBeenCalledWith({ action: "key", id: "emulator-5554", key: "back" });
	});

	it("shows a Simulator's screen without driving it", async () => {
		const device = deviceApi();
		await mount({ platform: "ios", id: "A1", name: "iPhone 16" });
		expect(device).toHaveBeenCalledWith({ action: "screen", platform: "ios", id: "A1" });
		expect(document.querySelector('button[aria-label="Back"]')).toBeNull();
		expect(document.body.textContent).toContain("computer use");
	});
});
