import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { faceDrawing, faceTraits, REST_FACE_POSE } from "../../lib/bot-face";
import { presencePose } from "../../lib/bot-face-acting";
import { attachBotFace } from "../../lib/bot-face-motion";
import { AvatarDynamics, activeFaceCount } from "../../lib/bot-face-rig";
import { BotAvatar } from "../bots/BotAvatar";
import { BotFace } from "./BotFace";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: (now: number) => void) => setTimeout(() => callback(performance.now()), 16);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);

let root: Root | null = null;
let host: HTMLElement;

async function mount(element: React.ReactElement): Promise<HTMLElement> {
	host = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(host as never);
	root = createRoot(host as unknown as Element);
	await act(async () => root?.render(element));
	return host;
}

function reducedMotion(matches: boolean) {
	(window as unknown as Record<string, unknown>).matchMedia = () => ({
		matches,
		addEventListener() {},
		removeEventListener() {},
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	host?.remove();
	vi.useRealTimers();
	Object.defineProperty(document, "hidden", { configurable: true, value: false });
});

const part = (node: HTMLElement, name: string) => node.querySelector(`[data-face-part="${name}"]`);

describe("a bot's face", () => {
	it("is the same face for the same bot on every device, and another bot's differs", async () => {
		const page = await mount(
			<>
				<BotFace seed="bot-0a1b2c3d4e5f" />
				<BotFace seed="bot-0a1b2c3d4e5f" />
				<BotFace seed="bot-ffeeddccbbaa" />
			</>,
		);
		const faces = [...page.querySelectorAll("[data-bot-face]")] as HTMLElement[];
		const look = (face: HTMLElement) =>
			["body", "left", "right"].map(name => part(face, name)?.getAttribute("d")).join("|") +
			part(face, "body")?.getAttribute("fill");
		expect(look(faces[0])).toBe(look(faces[1]));
		expect(look(faces[2])).not.toBe(look(faces[0]));
		const roster = Array.from({ length: 24 }, (_, i) => JSON.stringify(faceTraits(`bot-${i}`)));
		expect(new Set(roster).size).toBe(24);
	});

	it("shows an uploaded picture over the face, and the face when there is none", async () => {
		const picture = "data:image/png;base64,AAAA";
		const page = await mount(
			<>
				<BotAvatar bot={{ id: "bot-1", name: "Ada", picture }} />
				<BotAvatar bot={{ id: "bot-2", name: "Bea" }} />
			</>,
		);
		const [withPicture, withoutPicture] = [...page.querySelectorAll("[data-bot-avatar]")] as HTMLElement[];
		expect(withPicture.querySelector("img")?.getAttribute("src")).toBe(picture);
		expect(withPicture.querySelector("[data-bot-face]")).toBeNull();
		expect(withoutPicture.querySelector("[data-bot-face]")?.getAttribute("data-bot-face")).toBe("bot-2");
	});

	it("holds the rest pose under reduced motion, whatever its bot is doing", async () => {
		reducedMotion(true);
		const page = await mount(<BotFace seed="bot-1" />);
		const node = page.querySelector("[data-bot-face]") as HTMLElement;
		const motion = attachBotFace(node, "bot-1", "troubled");
		motion.update("thinking");
		const rest = faceDrawing(faceTraits("bot-1"), REST_FACE_POSE);
		expect(part(node, "body")?.getAttribute("d")).toBe(rest.body);
		expect(part(node, "left")?.getAttribute("d")).toBe(rest.left.path);
		expect(activeFaceCount()).toBe(0);
		motion.dispose();
	});

	it("keeps no timer and no frame while its window is hidden", async () => {
		vi.useFakeTimers();
		reducedMotion(false);
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		const page = await mount(<BotFace seed="bot-1" />);
		const node = page.querySelector("[data-bot-face]") as HTMLElement;
		const motion = attachBotFace(node, "bot-1", "idle");
		motion.update("thinking");
		motion.update("idle");
		expect(vi.getTimerCount()).toBe(0);
		expect(activeFaceCount()).toBe(0);
		// The state still reads, settled in one cut: the thinking squint, not the rest pose.
		motion.update("thinking");
		expect(vi.getTimerCount()).toBe(0);
		expect(part(node, "left")?.getAttribute("d")).not.toBe(
			faceDrawing(faceTraits("bot-1"), REST_FACE_POSE).left.path,
		);
		motion.dispose();
	});

	it("moves while awake and then settles, leaving the frame queue", async () => {
		vi.useFakeTimers();
		reducedMotion(false);
		const page = await mount(<BotFace seed="bot-1" />);
		const node = page.querySelector("[data-bot-face]") as HTMLElement;
		const motion = attachBotFace(node, "bot-1", "idle");
		motion.update("waiting");
		expect(activeFaceCount()).toBe(1);
		const rest = faceDrawing(faceTraits("bot-1"), REST_FACE_POSE).body;
		vi.advanceTimersByTime(3000);
		expect(activeFaceCount()).toBe(0);
		expect(part(node, "body")?.getAttribute("d")).not.toBe(rest);
		motion.dispose();
	});

	it("springs to the same pose at any refresh rate", () => {
		const poses = [30, 60, 120].map(hz => {
			const rig = new AvatarDynamics({ tempo: 1, lookDelayMs: 60, latencyMs: 0 });
			rig.retarget(presencePose("thinking", { x: 0.9, y: 0.2 }));
			rig.blink();
			for (let i = 0; i < hz / 2; i++) rig.step(1 / hz);
			return rig.pose;
		});
		for (const pose of poses.slice(1))
			for (const key of Object.keys(pose) as (keyof typeof pose)[]) expect(pose[key]).toBeCloseTo(poses[0][key], 3);
	});
});
