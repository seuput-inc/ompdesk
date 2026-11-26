/**
 * What moves a bot's face, loaded on demand by `BotFace` (adapted from momobot's `app/src/lib/agents/avatar-motion.ts`,
 * `useAvatarPresence` and its shared pointer and visibility watchers, MIT; LICENSES/MIT-momobot.txt). Every glance has
 * a cause: its bot's state (looking up to its own side while thinking), a pointer passing close (followed a little,
 * only while it is free or waiting on the person; a pause there turns the head), a press (a squash and a bounce). A
 * run that ends well gets a short cheer.
 *
 * Nothing runs on a clock while the face rests: a resting face has no timer and asks for no animation frame. A busy
 * face blinks at its own seeded rhythm; that is the only scheduled thing, and it stops with the run. A face off
 * screen, in a hidden window or under reduced motion lets go of its timers, its pointer watch and its frames; reduced
 * motion also shows the rest pose.
 */
import { type FacePresence, hashSeed, seededStream } from "./bot-face";
import { type AvatarLook, createAvatarRig } from "./bot-face-rig";

/** How one face's movement differs from the next one's, from the same seed that draws it. */
function personality(seed: string) {
	const hash = hashSeed(seed);
	return {
		// 0.82 to 1.26: wide enough to tell two faces apart, not so wide that one looks agitated.
		tempo: 0.82 + ((hash >>> 8) % 45) / 100,
		lookDelayMs: 35 + (hash % 65),
		latencyMs: 20 + ((hash >>> 14) % 121),
		blinkMs: 2800 + ((hash >>> 18) % 25) * 100,
		curiosity: 0.8 + ((hash >>> 23) % 46) / 100,
		/** Which side it keeps its own work on: a row of faces does not turn its heads in unison. */
		side: hash % 2 === 0 ? 1 : -1,
	};
}

const FORWARD: AvatarLook = { x: 0, y: 0 };
/** How close the cursor gets before a face notices it, in CSS pixels from its centre. */
const POINTER_REACH = 150;
/** The most a followed pointer moves the eyes: noticing, not staring. */
const POINTER_PULL = 1.1;
/** A cached rect this old is measured again. */
const RECT_STALE_MS = 400;
/** How long the cheer after a run lasts. */
export const CHEER_MS = 2600;
/** A face just off the edge is already awake, so scrolling one into view never catches it still. */
const VISIBLE_MARGIN = "128px";

/** One pointer listener for every face, handed out once per animation frame. */
type PointerWatcher = (x: number, y: number, now: number) => void;
const pointerWatchers = new Set<PointerWatcher>();
let pointerX = 0;
let pointerY = 0;
let pointerFrame = 0;

function onPointerMove(event: PointerEvent): void {
	pointerX = event.clientX;
	pointerY = event.clientY;
	if (pointerFrame) return;
	pointerFrame = requestAnimationFrame(now => {
		pointerFrame = 0;
		for (const watcher of [...pointerWatchers]) watcher(pointerX, pointerY, now);
	});
}

function onPointerLeave(): void {
	if (pointerFrame) cancelAnimationFrame(pointerFrame);
	pointerFrame = 0;
	for (const watcher of [...pointerWatchers])
		watcher(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, performance.now());
}

function watchPointer(watcher: PointerWatcher): () => void {
	pointerWatchers.add(watcher);
	if (pointerWatchers.size === 1) {
		window.addEventListener("pointermove", onPointerMove, { passive: true });
		document.addEventListener("pointerleave", onPointerLeave);
		window.addEventListener("blur", onPointerLeave);
	}
	return () => {
		pointerWatchers.delete(watcher);
		if (pointerWatchers.size > 0) return;
		window.removeEventListener("pointermove", onPointerMove);
		document.removeEventListener("pointerleave", onPointerLeave);
		window.removeEventListener("blur", onPointerLeave);
		if (pointerFrame) cancelAnimationFrame(pointerFrame);
		pointerFrame = 0;
	};
}

/** One intersection observer for every face. */
const visibilityListeners = new Map<Element, (visible: boolean) => void>();
let visibilityObserver: IntersectionObserver | null = null;

function watchVisibility(node: Element, onChange: (visible: boolean) => void): () => void {
	if (typeof IntersectionObserver === "undefined") return () => {};
	visibilityObserver ??= new IntersectionObserver(
		entries => {
			for (const entry of entries) visibilityListeners.get(entry.target)?.(entry.isIntersecting);
		},
		{ rootMargin: VISIBLE_MARGIN },
	);
	visibilityListeners.set(node, onChange);
	visibilityObserver.observe(node);
	return () => {
		visibilityListeners.delete(node);
		visibilityObserver?.unobserve(node);
		if (visibilityListeners.size > 0) return;
		visibilityObserver?.disconnect();
		visibilityObserver = null;
	};
}

/** States where a nearby pointer is worth a look: the bot is free, or attending to the person. */
const FOLLOWS_POINTER: Record<FacePresence, boolean> = {
	idle: true,
	waiting: true,
	happy: true,
	thinking: false,
	troubled: false,
};

export interface BotFaceMotion {
	/** Its bot's state changed. */
	update(presence: FacePresence): void;
	dispose(): void;
}

/** Brings the face `BotFace` drew in `node` to life for `seed`, starting in `presence`. */
export function attachBotFace(node: HTMLElement, seed: string, presence: FacePresence): BotFaceMotion {
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
	const traits = personality(seed);
	const rig = createAvatarRig(node, seed, traits);
	let wanted = presence;
	let shown: FacePresence = presence === "happy" ? "idle" : presence;
	let visible = true;
	let pointer: AvatarLook | null = null;
	let pointerHead = false;
	let pointerAnchor: AvatarLook | null = null;
	let pointerTimer: ReturnType<typeof setTimeout> | undefined;
	let blinkTimer: ReturnType<typeof setTimeout> | undefined;
	let cheerTimer: ReturnType<typeof setTimeout> | undefined;
	const blinkStream = seededStream(`${seed}:blink`);
	const awake = () => visible && !document.hidden && !reduced?.matches;
	const stopTimers = () => {
		for (const timer of [pointerTimer, blinkTimer, cheerTimer]) clearTimeout(timer);
		pointerTimer = blinkTimer = cheerTimer = undefined;
	};

	const keepBlinking = () => {
		if (blinkTimer || !awake() || shown !== "thinking") return;
		blinkTimer = setTimeout(
			() => {
				blinkTimer = undefined;
				if (!awake() || shown !== "thinking") return;
				rig.blink();
				keepBlinking();
			},
			traits.blinkMs * (0.7 + 0.6 * blinkStream()),
		);
	};

	const apply = () => {
		if (reduced?.matches) {
			rig.update("idle", FORWARD, true);
			return;
		}
		const followsPointer = pointer !== null && FOLLOWS_POINTER[shown];
		const look =
			followsPointer && pointer ? pointer : shown === "thinking" ? { x: 0.66 * traits.side, y: -0.7 } : FORWARD;
		rig.update(shown, look, !followsPointer || pointerHead);
		if (shown === "thinking") keepBlinking();
		else if (blinkTimer) {
			clearTimeout(blinkTimer);
			blinkTimer = undefined;
		}
	};

	let rect: DOMRect | null = null;
	let measuredAt = Number.NEGATIVE_INFINITY;
	const dropPointer = () => {
		clearTimeout(pointerTimer);
		pointerTimer = undefined;
		pointerAnchor = null;
		pointerHead = false;
		pointer = null;
	};
	const followPointer = (x: number, y: number, now: number) => {
		if (now - measuredAt > RECT_STALE_MS) {
			rect = node.getBoundingClientRect();
			measuredAt = now;
		}
		if (!rect || rect.width === 0) return;
		const dx = x - (rect.left + rect.width / 2);
		const dy = y - (rect.top + rect.height / 2);
		const distance = Math.hypot(dx, dy);
		const reach = Math.max(POINTER_REACH * traits.curiosity, rect.width * 1.8);
		if (distance > reach) {
			if (!pointer) return;
			dropPointer();
			apply();
			return;
		}
		const eager = shown === "waiting" ? 1.25 : 1;
		const edge = Math.min(1, (reach - distance) / (reach * 0.25));
		const pull =
			POINTER_PULL * traits.curiosity * eager * Math.min(1, distance / Math.max(32, rect.width * 0.8)) * edge;
		pointer = distance < 1 ? FORWARD : { x: (dx / distance) * pull, y: (dy / distance) * pull };
		apply();
		if (!FOLLOWS_POINTER[shown] || pointerHead) return;
		// A passing cursor gets a glance of the eyes; a deliberate pause invites the head to follow.
		if (!pointerAnchor || Math.hypot(x - pointerAnchor.x, y - pointerAnchor.y) > Math.max(10, rect.width * 0.1)) {
			clearTimeout(pointerTimer);
			pointerTimer = undefined;
			pointerAnchor = { x, y };
		}
		pointerTimer ??= setTimeout(
			() => {
				pointerTimer = undefined;
				if (!awake() || !pointer || !FOLLOWS_POINTER[shown]) return;
				pointerHead = true;
				apply();
				rig.notice();
			},
			(260 * traits.tempo) / traits.curiosity,
		);
	};

	let detachPointer: (() => void) | undefined;
	const updateActivity = () => {
		const active = awake();
		if (!active) {
			rig.setActive(false);
			detachPointer?.();
			detachPointer = undefined;
			stopTimers();
			dropPointer();
			rect = null;
			measuredAt = Number.NEGATIVE_INFINITY;
			// A cheer nobody saw is over.
			shown = wanted;
		} else detachPointer ??= watchPointer(followPointer);
		apply();
		rig.setActive(active);
	};

	apply();
	updateActivity();
	const detachVisibility = watchVisibility(node, onScreen => {
		visible = onScreen;
		updateActivity();
	});
	const touch = () => rig.touch();
	node.addEventListener("pointerdown", touch);
	reduced?.addEventListener?.("change", updateActivity);
	document.addEventListener("visibilitychange", updateActivity);

	return {
		update(next) {
			const before = wanted;
			wanted = next;
			clearTimeout(cheerTimer);
			cheerTimer = undefined;
			// A run that ended with nothing wrong and nobody needed: a short cheer, then rest.
			if (before === "thinking" && next === "idle" && awake()) {
				shown = "happy";
				cheerTimer = setTimeout(() => {
					cheerTimer = undefined;
					shown = wanted;
					apply();
				}, CHEER_MS);
			} else shown = next;
			apply();
		},
		dispose() {
			detachVisibility();
			detachPointer?.();
			stopTimers();
			rig.dispose();
			node.removeEventListener("pointerdown", touch);
			reduced?.removeEventListener?.("change", updateActivity);
			document.removeEventListener("visibilitychange", updateActivity);
		},
	};
}
