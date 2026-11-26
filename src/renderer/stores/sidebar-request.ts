/**
 * What a palette command or a header menu asks of the sidebar: a list action (Orca's "Reveal current", "Collapse all
 * projects", the clone) the sidebar takes once it is drawn, so a hidden sidebar is shown first and does it as it
 * mounts; and the one project dialog open (move to a group, rename a group, appearance), which the sidebar draws for
 * this computer's list and every paired host's.
 */
import { create } from "zustand";
import type { ProjectDialogRequest } from "../components/layout/sidebar/ProjectDialogs";
import { useUiStore } from "./ui";

export type SidebarRequest = "reveal-current" | "fold-projects" | "unfold-projects" | "clone";

export const useSidebarRequest = create<{ request: SidebarRequest | null; dialog: ProjectDialogRequest | null }>(
	() => ({ request: null, dialog: null }),
);

export function askSidebar(request: SidebarRequest): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.getState().toggleSidebar();
	useSidebarRequest.setState({ request });
}

export function openProjectDialog(dialog: ProjectDialogRequest | null): void {
	useSidebarRequest.setState({ dialog });
}
