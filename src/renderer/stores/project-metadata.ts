import { create } from "zustand";
import { PROJECT_METADATA_BATCH, type ProjectMetadata, type ProjectMetadataBatch } from "../../shared/project-metadata";

export function projectMetadataKey(path: string, device?: string): string {
	return JSON.stringify([device ?? null, path]);
}

interface State {
	entries: Record<string, ProjectMetadata | null>;
	request(paths: readonly string[], device?: string): void;
	refresh(paths: readonly string[], device?: string): void;
	reset(): void;
}

const expires = new Map<string, number>();
const pending = new Map<string, Set<string>>();
const inFlight = new Map<string, number>();
let revision = 0;
let scheduled = false;
let epoch = 0;

export const useProjectMetadata = create<State>((set, get) => {
	async function load(paths: string[], device: string | undefined, generation: number): Promise<void> {
		const requests = new Map(
			paths.map(path => {
				const key = projectMetadataKey(path, device);
				const token = ++revision;
				inFlight.set(key, token);
				return [key, token];
			}),
		);
		let result: ProjectMetadataBatch;
		try {
			result = await window.omp.projectMetadata.get(paths, device);
		} catch {
			// Keep the last picture/label offline. No retry loop or per-row timer runs.
			result = {};
		}
		if (generation !== epoch) return;
		const updates: Record<string, ProjectMetadata | null> = {};
		for (const path of paths) {
			const key = projectMetadataKey(path, device);
			if (inFlight.get(key) !== requests.get(key)) continue;
			inFlight.delete(key);
			const received = result[path];
			if (received !== undefined) updates[key] = received;
			else if (!(key in get().entries)) updates[key] = null;
			expires.set(key, Date.now() + (received ? 30_000 : 60_000));
		}
		if (Object.keys(updates).length > 0)
			set(state => {
				const entries = { ...state.entries, ...updates };
				for (const key of Object.keys(entries).slice(0, Math.max(0, Object.keys(entries).length - 512))) {
					delete entries[key];
					expires.delete(key);
				}
				return { entries };
			});
	}

	function flush(): void {
		scheduled = false;
		const batches = [...pending];
		pending.clear();
		for (const [device, values] of batches) {
			const paths = [...values];
			for (let offset = 0; offset < paths.length; offset += PROJECT_METADATA_BATCH) {
				void load(paths.slice(offset, offset + PROJECT_METADATA_BATCH), device || undefined, epoch);
			}
		}
	}

	function request(paths: readonly string[], device?: string): void {
		const wanted = pending.get(device ?? "") ?? new Set<string>();
		for (const path of paths) {
			const key = projectMetadataKey(path, device);
			if (!path || inFlight.has(key) || (expires.get(key) ?? 0) > Date.now()) continue;
			wanted.add(path);
		}
		if (wanted.size === 0) return;
		pending.set(device ?? "", wanted);
		if (!scheduled) {
			scheduled = true;
			queueMicrotask(flush);
		}
	}

	return {
		entries: {},
		request,
		refresh: (paths, device) => {
			for (const path of paths) {
				const key = projectMetadataKey(path, device);
				expires.delete(key);
				inFlight.delete(key);
			}
			request(paths, device);
		},
		reset: () => {
			epoch++;
			pending.clear();
			expires.clear();
			inFlight.clear();
			set({ entries: {} });
		},
	};
});
