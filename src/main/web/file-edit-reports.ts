/**
 * What paired web pages' live connections last reported about unsaved edits in their Files editors, as main reads
 * it. The store is the core's web router (`crates/core/src/web/file_edits.rs`, C2): it records a connection's report
 * in the frame's own run and forgets it in the step that ends the connection, so an ended connection's word never
 * counts again, and an agent's release checks it in the core step that removes the tab (`releaseTab`'s
 * `unlessDirty`). The page reports on every change and on every (re)connect (`FileEditReporter`).
 *
 * `edits` is what an agent's close reads (`tabCloseStep`): `dirty` when a live connection names the tab, `clean` when
 * some live connection reported and none names it, `unreported` when none has (none since this launch, or every
 * reporting one dropped), never assumed clean.
 */

/** What a window's live reports say about one of its tabs. */
export type FileEdits = "clean" | "dirty" | "unreported";

/** The core's router (`WsRouter.host`) and the device whose live connections are asked about a tab. */
export interface FileEditTarget {
	host: number;
	device: string;
}

export interface FileEditReportsDeps {
	/** The paired device behind window `windowId`, or null for a desktop window or while no web server runs. */
	target(windowId: number): FileEditTarget | null;
	/** The core's answer for one tab (the pool's `fileEdits`). */
	read(target: FileEditTarget, tabId: string): FileEdits;
}

export class FileEditReports {
	readonly #deps: FileEditReportsDeps;
	readonly #listeners = new Set<() => void>();

	constructor(deps: FileEditReportsDeps) {
		this.#deps = deps;
	}

	target(windowId: number): FileEditTarget | null {
		return this.#deps.target(windowId);
	}

	edits(windowId: number, tabId: string): FileEdits {
		const target = this.#deps.target(windowId);
		return target ? this.#deps.read(target, tabId) : "unreported";
	}

	/** The core recorded a report (`web.fileEdits`): tell every listener. */
	reported(): void {
		for (const listener of [...this.#listeners]) listener();
	}

	/** Called after every report; returns the unsubscribe. */
	onReport(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
}
