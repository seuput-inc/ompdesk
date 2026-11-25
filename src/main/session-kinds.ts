/**
 * GUI-side record of which sessions are chats, so the sidebar lists them in its Chats section: main's client of the
 * core's record (`native/ompdesk/crates/core/src/sessions/kinds.rs`, hub kind `kinds`). Stock omp has no session kind:
 * a chat tab is plain omp started in the GUI's default workspace, so the GUI remembers the ids of the sessions its chat
 * tabs created; the core labels them when the session index lists (`file`, passed to `sessions.listed`). The mark is a
 * synchronous hub call, so a new chat is labelled before the next list is read.
 */
import { hub } from "./core/hub";

let instanceId: number | null = null;

function instance(): number {
	if (instanceId !== null) return instanceId;
	const id = hub().nextId();
	hub().open(
		id,
		"kinds",
		{},
		{
			item: () => {},
			ask: q => {
				throw new Error(`the session kinds ask nothing (${q})`);
			},
			lost: () => {
				if (instanceId === id) instanceId = null;
			},
		},
	);
	instanceId = id;
	return id;
}

export class SessionKindStore {
	readonly file: string;

	constructor(file: string) {
		this.file = file;
	}

	/** Record a chat session id; saved by the core, and again later when the disk is full. Never throws into the event. */
	markChat(sessionId: string): void {
		try {
			hub().callOnce(instance, "mark", { file: this.file, id: sessionId });
		} catch (err) {
			console.warn(
				`[session-kinds] could not mark ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}
