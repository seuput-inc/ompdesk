import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useUiStore } from "../stores/ui";
import { isNotificationTone, NOTIFICATION_TONES, playChime, playNotificationSound } from "./notification-sound";

/** What the fake audio graph was asked to play: each oscillator's frequency and start time. */
const played: { frequency: number; start: number }[] = [];

class FakeAudioContext {
	currentTime = 10;
	destination = {};
	resume = async () => undefined;
	createGain() {
		const gain = { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined };
		return { gain, connect: (next: unknown) => next };
	}
	createOscillator() {
		const note = { frequency: 0, start: 0 };
		return {
			type: "",
			frequency: {
				set value(hz: number) {
					note.frequency = hz;
				},
			},
			connect: (next: unknown) => next,
			start: (at: number) => {
				note.start = at;
				played.push(note);
			},
			stop: () => undefined,
		};
	}
}

beforeAll(() => vi.stubGlobal("AudioContext", FakeAudioContext));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
	played.length = 0;
});

describe("notification tones", () => {
	it("plays each tone's own notes in order", () => {
		playChime(50, "tick");
		expect(played.map(note => note.frequency)).toEqual([1760, 1760, 1760]);
		expect(played.map(note => Math.round((note.start - 10.01) * 100) / 100)).toEqual([0, 0.1, 0.2]);
		played.length = 0;
		playChime(50);
		expect(played.map(note => note.frequency)).toEqual([880, 1318.5]);
	});

	it("gives every tone at least one note and stays silent at volume 0", () => {
		for (const tone of NOTIFICATION_TONES) {
			played.length = 0;
			playChime(30, tone);
			expect(played.length, tone).toBeGreaterThan(0);
		}
		played.length = 0;
		playChime(0, "bell");
		expect(played).toEqual([]);
	});

	it("plays the chosen tone for a notification only while the sound is on", () => {
		useUiStore.setState({ notificationSound: false, notificationTone: "pop", notificationVolume: 60 });
		playNotificationSound();
		expect(played).toEqual([]);
		useUiStore.setState({ notificationSound: true });
		playNotificationSound();
		expect(played.map(note => note.frequency)).toEqual([587.3]);
	});

	it("knows its tones", () => {
		expect(isNotificationTone("bell")).toBe(true);
		expect(isNotificationTone("custom.wav")).toBe(false);
		expect(isNotificationTone(3)).toBe(false);
	});
});
