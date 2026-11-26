/**
 * The notification sounds: a few short sine tones synthesized with Web Audio, so the app ships no sound file. One
 * plays with each desktop notification when Settings › General › Notification sound is on (`notificationTone`
 * picks which); the row's "Play" button and the volume slider call `playChime` directly.
 */

import { useUiStore } from "../stores/ui";

export const NOTIFICATION_TONES = ["chime", "pop", "bell", "tick"] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

export function isNotificationTone(value: unknown): value is NotificationTone {
	return NOTIFICATION_TONES.includes(value as NotificationTone);
}

/** Each note: frequency (Hz), start offset and length (seconds). */
interface Note {
	frequency: number;
	at: number;
	length: number;
}

const TONES: Record<NotificationTone, readonly Note[]> = {
	chime: [
		{ frequency: 880, at: 0, length: 0.22 },
		{ frequency: 1318.5, at: 0.12, length: 0.32 },
	],
	pop: [{ frequency: 587.3, at: 0, length: 0.12 }],
	bell: [
		{ frequency: 1046.5, at: 0, length: 0.5 },
		{ frequency: 784, at: 0.28, length: 0.6 },
	],
	tick: [
		{ frequency: 1760, at: 0, length: 0.05 },
		{ frequency: 1760, at: 0.1, length: 0.05 },
		{ frequency: 1760, at: 0.2, length: 0.05 },
	],
};

let context: AudioContext | null = null;

/** Plays `tone` at `volume` (0–100); silent where Web Audio is missing. */
export function playChime(volume: number, tone: NotificationTone = "chime"): void {
	if (typeof AudioContext === "undefined" || volume <= 0) return;
	context ??= new AudioContext();
	const audio = context;
	void audio.resume().catch(() => {});
	const peak = (Math.min(volume, 100) / 100) * 0.4;
	const start = audio.currentTime + 0.01;
	for (const note of TONES[tone]) {
		const oscillator = audio.createOscillator();
		const gain = audio.createGain();
		oscillator.type = "sine";
		oscillator.frequency.value = note.frequency;
		gain.gain.setValueAtTime(0.0001, start + note.at);
		gain.gain.exponentialRampToValueAtTime(peak, start + note.at + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, start + note.at + note.length);
		oscillator.connect(gain).connect(audio.destination);
		oscillator.start(start + note.at);
		oscillator.stop(start + note.at + note.length + 0.02);
	}
}

/** The sound for a shown notification, when the user turned it on. */
export function playNotificationSound(): void {
	const { notificationSound, notificationVolume, notificationTone } = useUiStore.getState();
	if (notificationSound) playChime(notificationVolume, notificationTone);
}
