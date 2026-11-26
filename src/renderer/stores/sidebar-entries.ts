/**
 * A computer's keyed sidebar entries (project groups, colors and emoji, a session's emoji and parent), read and set
 * the same way for this computer's list and a paired host's: this computer's from its `sidebar` prefs, a host's from
 * the layout its list carries (a host older than them has none), each change sent to the computer that owns it.
 */
import type { SidebarEntryField, SidebarPrefs } from "../../shared/sidebar-prefs";
import { translate } from "../lib/i18n";
import { useSidebarPrefs } from "./sidebar-prefs";
import { useSidebarProjects } from "./sidebar-projects";
import { toastError } from "./toast";

export type SidebarEntries = Pick<SidebarPrefs, SidebarEntryField>;

const NONE: Readonly<Record<string, string>> = {};

/** One field of a computer's entries (`device` absent: this computer). */
export function useSidebarEntry(field: SidebarEntryField, device?: string): Readonly<Record<string, string>> {
	const local = useSidebarPrefs(s => s[field]);
	const hosted = useSidebarProjects(s => (device === undefined ? undefined : s.lists[device]?.layout?.[field]));
	return device === undefined ? local : (hosted ?? NONE);
}

async function changeOn(
	device: string | undefined,
	change:
		| { op: "set-entry"; field: SidebarEntryField; key: string; value: string | null }
		| { op: "rename-project-group"; from: string; to: string | null },
): Promise<void> {
	if (device === undefined) {
		const prefs = useSidebarPrefs.getState();
		await (change.op === "set-entry"
			? prefs.setEntry(change.field, change.key, change.value)
			: prefs.renameProjectGroup(change.from, change.to));
		return;
	}
	const projects = useSidebarProjects.getState();
	const layout = projects.liveLayouts[device];
	try {
		if (!layout) throw new Error(translate("prefs.unreadable"));
		await projects.changeLayout(device, layout, change);
	} catch (error) {
		toastError({ title: translate("sidebar.entryFailed"), error });
	}
}

export function setSidebarEntry(
	device: string | undefined,
	field: SidebarEntryField,
	key: string,
	value: string | null,
): Promise<void> {
	return changeOn(device, { op: "set-entry", field, key, value });
}

export function renameProjectGroup(device: string | undefined, from: string, to: string | null): Promise<void> {
	return changeOn(device, { op: "rename-project-group", from, to });
}
