/**
 * Where this app reads the verified-omp list (src/shared/omp-compat.ts) from: the `omp-compat` branch of the public
 * repository, which only omp-latest.yml writes. Read at most every 15 minutes; a failed or malformed read keeps the
 * last good list, which is also kept in `<userData>/omp-compat.json` so a launch without network still follows what
 * an earlier launch read. Before any read succeeded the list is empty, so a pass installs at most the tested omp.
 */
import { OMP_COMPAT_BRANCH, OMP_COMPAT_FILE, type OmpCompatList, parseOmpCompat } from "../shared/omp-compat";
import type { CoreProcess } from "./core/process";

export const OMP_COMPAT_URL = `https://raw.githubusercontent.com/seuput-inc/ompdesk/${OMP_COMPAT_BRANCH}/${OMP_COMPAT_FILE}`;
const FRESH_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000;
/** The workflow's file stays far below this; anything larger is not read. */
const MAX_BYTES = 1024 * 1024;

export interface OmpCompatSourceDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** Main supplies its own userData, never a file name from the list. Null keeps the list in memory. */
	cache: { userData: string; host: CoreProcess } | null;
	now?: () => number;
}

export class OmpCompatSource {
	readonly #deps: OmpCompatSourceDeps;
	readonly #offReady?: () => void;
	#list: OmpCompatList | null = null;
	#pending: Uint8Array | null = null;
	#sentTo = 0;
	#writeEnded: Promise<void> | null = null;
	#disposed = false;
	#readAt = Number.NEGATIVE_INFINITY;
	#reading: Promise<OmpCompatList | null> | null = null;

	constructor(deps: OmpCompatSourceDeps) {
		this.#deps = deps;
		this.#offReady = deps.cache?.host.on("ready", (_data, _bin, generation) => {
			if (this.#pending && this.#sentTo !== generation) void this.#save(this.#pending, generation);
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#pending = null;
		this.#offReady?.();
	}

	/** The newest good list: read again when the last read is older than 15 minutes, else the one in hand. */
	read(): Promise<OmpCompatList | null> {
		if (this.#reading) return this.#reading;
		const now = (this.#deps.now ?? Date.now)();
		if (this.#disposed || now - this.#readAt < FRESH_MS) return Promise.resolve(this.#list);
		this.#reading = this.#fetch(now).finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	async #fetch(now: number): Promise<OmpCompatList | null> {
		try {
			const response = await this.#deps.fetch(OMP_COMPAT_URL, {
				cache: "no-store",
				signal: AbortSignal.timeout(READ_TIMEOUT_MS),
			});
			// A missing branch is a good, empty list. Other failures keep the last good one.
			if (!response.ok) void response.body?.cancel().catch(() => {});
			const bytes = response.status === 404 ? Buffer.from("{}\n") : response.ok ? await readBody(response) : null;
			const list = bytes && parseBytes(bytes);
			if (bytes && list && !this.#disposed) {
				this.#list = list;
				this.#readAt = now;
				if (this.#deps.cache) {
					this.#pending = bytes;
					await this.#save(bytes);
				}
			}
		} catch {
			// An offline first read still has the copy from the previous launch.
		}
		const cache = this.#deps.cache;
		if (!this.#list && cache && !this.#disposed) {
			try {
				const { bin } = await cache.host.call("setup.readCompatCache", { userData: cache.userData });
				if (bin) this.#list = parseBytes(bin);
			} catch {
				// The core may be unavailable. The next read can try again.
			}
		}
		return this.#list;
	}

	async #save(bytes: Uint8Array, generation?: number): Promise<void> {
		const cache = this.#deps.cache;
		if (!cache) return;
		const { host, userData } = cache;
		// Even a timed-out RPC can still finish its rename. Wait for its actual end before sending a newer save.
		while (this.#writeEnded) await this.#writeEnded;
		if (this.#pending !== bytes) return;
		try {
			if (generation !== undefined) {
				if (generation !== host.generation || generation === this.#sentTo) return;
				// The lost core may have finished its disk-full retry without a reply to the original save.
				const { bin } = await host.call("setup.readCompatCache", { userData }, { generation });
				if (this.#pending !== bytes || generation !== host.generation) return;
				if (bin && Buffer.compare(bytes, bin) === 0) {
					this.#pending = null;
					return;
				}
			}
			const ended = Promise.withResolvers<void>();
			this.#writeEnded = ended.promise;
			const saving = host.call(
				"setup.saveCompatCache",
				{ userData },
				{
					bin: bytes,
					generation,
					onEnded: () => {
						this.#writeEnded = null;
						ended.resolve();
					},
				},
			);
			this.#sentTo = host.generation;
			await saving;
			if (this.#pending === bytes) this.#pending = null;
		} catch {
			// The core alone backs off on a full disk. Keep the newest bytes for its replacement.
		}
	}
}

function parseBytes(bytes: Uint8Array): OmpCompatList | null {
	return parseOmpCompat(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function readBody(response: Response): Promise<Uint8Array | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
			size += value.byteLength;
			if (size > MAX_BYTES) return null;
			if (value.byteLength) chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
