/**
 * Where this app reads the verified-omp list (src/shared/omp-compat.ts) from: the `omp-compat` branch of the public
 * repository, which only omp-latest.yml writes. Read at most every 15 minutes; a failed or malformed read keeps the
 * last good list, which is also kept in `<userData>/omp-compat.json` so a launch without network still follows what
 * an earlier launch read. Before any read succeeded the list is empty, so a pass installs at most the tested omp.
 */
import { readFileSync } from "node:fs";
import { OMP_COMPAT_BRANCH, OMP_COMPAT_FILE, type OmpCompatList, parseOmpCompat } from "../shared/omp-compat";
import { AtomicSaver } from "./atomic-file";

export const OMP_COMPAT_URL = `https://raw.githubusercontent.com/seuput-inc/ompdesk/${OMP_COMPAT_BRANCH}/${OMP_COMPAT_FILE}`;
const FRESH_MS = 15 * 60_000;
const READ_TIMEOUT_MS = 15_000;
/** The workflow's file stays far below this; anything larger is not read. */
const MAX_BYTES = 1024 * 1024;

export interface OmpCompatSourceDeps {
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	/** The last good list's copy; null keeps it in memory only. */
	file: string | null;
	url?: string;
	now?: () => number;
}

export class OmpCompatSource {
	readonly #deps: OmpCompatSourceDeps;
	readonly #saver: AtomicSaver;
	#list: OmpCompatList | null;
	#readAt = Number.NEGATIVE_INFINITY;
	#reading: Promise<OmpCompatList | null> | null = null;

	constructor(deps: OmpCompatSourceDeps) {
		this.#deps = deps;
		this.#saver = new AtomicSaver(deps.file);
		this.#list = deps.file ? readKept(deps.file) : null;
	}

	/** The newest good list: read again when the last read is older than 15 minutes, else the one in hand. */
	read(): Promise<OmpCompatList | null> {
		const now = (this.#deps.now ?? Date.now)();
		if (now - this.#readAt < FRESH_MS) return Promise.resolve(this.#list);
		this.#reading ??= this.#fetch(now).finally(() => {
			this.#reading = null;
		});
		return this.#reading;
	}

	async #fetch(now: number): Promise<OmpCompatList | null> {
		try {
			const response = await this.#deps.fetch(this.#deps.url ?? OMP_COMPAT_URL, {
				cache: "no-store",
				signal: AbortSignal.timeout(READ_TIMEOUT_MS),
			});
			// No list yet (the branch is made by the first verdict): nothing verified, which is a good read.
			if (response.status === 404) return this.#keep(now, Object.create(null) as OmpCompatList, "{}\n");
			if (!response.ok) return this.#list;
			const text = await response.text();
			const list = text.length <= MAX_BYTES ? parseOmpCompat(text) : null;
			return list ? this.#keep(now, list, text) : this.#list;
		} catch {
			return this.#list;
		}
	}

	#keep(now: number, list: OmpCompatList, text: string): OmpCompatList {
		this.#readAt = now;
		this.#list = list;
		this.#saver.save(text);
		return list;
	}
}

function readKept(file: string): OmpCompatList | null {
	try {
		return parseOmpCompat(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}
