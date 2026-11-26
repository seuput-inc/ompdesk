/**
 * What a palette command asks of the sidebar's list (Orca's "Reveal current" and "Collapse all projects"): the
 * sidebar takes it once it is drawn, so a hidden sidebar is shown first and does it as it mounts.
 */
import { create } from "zustand";
import { useUiStore } from "./ui";

export type SidebarRequest = "reveal-current" | "fold-projects" | "unfold-projects";

export const useSidebarRequest = create<{ request: SidebarRequest | null }>(() => ({ request: null }));

export function askSidebar(request: SidebarRequest): void {
	if (!useUiStore.getState().sidebarVisible) useUiStore.getState().toggleSidebar();
	useSidebarRequest.setState({ request });
}
