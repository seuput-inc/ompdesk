/**
 * macOS: stock `/usr/bin/caffeinate -s -w <pid>` holds a PreventSystemSleep assertion, which macOS honours only on AC
 * power, for as long as it runs; `-w` ends it with OMPdesk's main process, so a crash or kill leaves nothing held.
 * No admin rights and no `pmset disablesleep`. Whether that assertion alone keeps a MacBook awake with its lid closed
 * and no external display is the one fact this route rests on; only this file changes if it needs another.
 *
 * A caffeinate that ends while the hold stands (killed by someone else, a crash) holds nothing any more, so it is
 * started again after `RESPAWN_MS`, doubling up to 16 times that while it keeps ending.
 */

import type { LidAwakeLog, LidBackend, LidHoldOutcome } from "./lid-awake";

export interface CaffeinateHandle {
	stop(): void;
}

export interface MacLidOptions {
	/** Start `caffeinate -s -w <pid>`; `onExit` hears it end, by `stop()` or otherwise. */
	caffeinate: (onExit: () => void) => CaffeinateHandle;
	/** `pmset -g batt`. */
	batteryReport: () => Promise<string>;
	log?: LidAwakeLog;
}

export const RESPAWN_MS = 30_000;
const RESPAWN_MAX_MS = 16 * RESPAWN_MS;

export class MacLidBackend implements LidBackend {
	readonly name = "caffeinate";
	readonly #options: MacLidOptions;
	#handle: CaffeinateHandle | undefined;
	#respawn: NodeJS.Timeout | undefined;
	#exits = 0;

	constructor(options: MacLidOptions) {
		this.#options = options;
	}

	async isLaptop(): Promise<boolean> {
		return (await this.#options.batteryReport()).includes("InternalBattery");
	}

	async recover(): Promise<null> {
		return null;
	}

	async hold(): Promise<LidHoldOutcome> {
		if (!this.#handle) this.#start();
		return { changed: true };
	}

	async release(): Promise<void> {
		this.releaseNow();
	}

	releaseNow(): void {
		const handle = this.#handle;
		this.#handle = undefined;
		clearTimeout(this.#respawn);
		this.#respawn = undefined;
		this.#exits = 0;
		handle?.stop();
	}

	#start(): void {
		const handle = this.#options.caffeinate(() => {
			if (this.#handle !== handle) return;
			const delay = Math.min(RESPAWN_MS * 2 ** this.#exits++, RESPAWN_MAX_MS);
			this.#options.log?.("restarted", { holder: this.name, exits: this.#exits, inMs: delay });
			this.#respawn = setTimeout(() => {
				this.#respawn = undefined;
				if (this.#handle === handle) this.#start();
			}, delay);
			this.#respawn.unref?.();
		});
		this.#handle = handle;
	}
}
