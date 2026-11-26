import type { SessionInfo } from "../shared/ipc-types";
import type { SidebarPrefs } from "../shared/sidebar-prefs";
import type { SidebarLayout, SidebarLayoutChange, SidebarProjectsState } from "../shared/sidebar-projects";
import { CHATS_ORDER_KEY, isChatSession } from "../shared/sidebar-rows";

/** Only the slots visible to the sender move. Hidden and other devices' entries remain on the owning computer. */
function reorder(current: readonly string[], order: string[], visible: (key: string) => boolean): string[] {
	let index = 0;
	const result: string[] = [];
	for (const key of current) {
		if (!visible(key)) result.push(key);
		else if (index < order.length) result.push(order[index++] as string);
	}
	return result.concat(order.slice(index));
}

export class SidebarLayoutScope {
	readonly #groups: Set<string>;
	readonly #lists = new Map<string, string>();
	readonly #ids = new Set<string>();

	constructor(
		state: SidebarProjectsState,
		sessions: readonly Pick<
			SessionInfo,
			"path" | "id" | "cwd" | "kind" | "messageCount" | "title" | "firstMessage"
		>[],
		workspace: string,
		hidden: readonly string[],
	) {
		this.#groups = new Set(state.projects.map(project => project.path));
		const excluded = new Set(hidden);
		for (const session of sessions) {
			if (
				excluded.has(session.path) ||
				!(session.messageCount || session.title?.trim() || session.firstMessage?.trim())
			)
				continue;
			const list = isChatSession(session, workspace)
				? CHATS_ORDER_KEY
				: (state.worktrees[session.cwd] ?? session.cwd);
			this.#lists.set(session.path, list);
			this.#ids.add(session.id);
			if (list !== CHATS_ORDER_KEY && !state.removed.includes(list)) this.#groups.add(list);
		}
	}

	read(prefs: SidebarPrefs): SidebarLayout {
		const sessionOrder: Record<string, string[]> = {};
		for (const [list, order] of Object.entries(prefs.sessionOrder)) {
			if (list !== CHATS_ORDER_KEY && !this.#groups.has(list)) continue;
			const visible = order.filter(path => this.#lists.get(path) === list);
			if (visible.length) sessionOrder[list] = visible;
		}
		const shown = (entries: Record<string, string>, visible: (key: string) => boolean) =>
			Object.fromEntries(Object.entries(entries).filter(([key]) => visible(key)));
		const group = (key: string) => this.#groups.has(key);
		const session = (key: string) => this.#lists.has(key);
		return {
			pinnedGroups: prefs.pinnedGroups.filter(key => this.#groups.has(key)),
			pinnedSessions: prefs.pinnedSessions.filter(key => this.#lists.has(key)),
			archivedSessions: prefs.archivedSessions.filter(id => this.#ids.has(id)),
			groupOrder: prefs.groupOrder.filter(key => this.#groups.has(key)),
			sessionOrder,
			projectGroups: shown(prefs.projectGroups, group),
			projectColors: shown(prefs.projectColors, group),
			projectEmoji: shown(prefs.projectEmoji, group),
			sessionEmoji: shown(prefs.sessionEmoji, session),
			sessionParents: shown(prefs.sessionParents, session),
		};
	}

	change(change: SidebarLayoutChange, prefs: SidebarPrefs): SidebarLayoutChange {
		switch (change.op) {
			case "set-group-pinned":
				if (this.#groups.has(change.cwd)) return change;
				break;
			case "set-session-pinned":
				if (this.#lists.has(change.path)) return change;
				break;
			case "set-sessions-archived":
				if (change.ids.every(id => this.#ids.has(id))) return change;
				break;
			case "set-group-order": {
				const visible = (key: string) => this.#groups.has(key);
				if (change.order.every(visible))
					return { ...change, order: reorder(prefs.groupOrder, change.order, visible) };
				break;
			}
			case "set-session-order": {
				const { list, move } = change;
				if (list !== CHATS_ORDER_KEY && !this.#groups.has(list)) break;
				const visible = (key: string) => this.#lists.get(key) === list;
				const order = change.order.filter(visible);
				const slots = new Set(order);
				// A paired view can include protected rows or lag a deletion. Neither is part of this gesture.
				if (move) {
					if (move.path === move.over || !slots.has(move.path) || !slots.has(move.over)) break;
				} else if (order.length !== change.order.length) break;
				return {
					op: change.op,
					list,
					order: reorder(prefs.sessionOrder[list] ?? [], order, key => slots.has(key)),
				};
			}
			case "set-entry": {
				const visible =
					change.field === "projectGroups" || change.field === "projectColors" || change.field === "projectEmoji"
						? this.#groups.has(change.key)
						: this.#lists.has(change.key) &&
							(change.field !== "sessionParents" || !change.value || this.#lists.has(change.value));
				if (visible) return change;
				break;
			}
			case "rename-project-group":
				return change;
		}
		throw new Error("The sidebar row is not available on this host");
	}
}
