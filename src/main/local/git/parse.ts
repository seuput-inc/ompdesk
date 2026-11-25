/** Pure parsers/projections for the GUI-side git commands (unit-tested). */
import * as path from "node:path";

/** A branch or tag name git accepts (`git check-ref-format --branch` rules, checked without spawning git). */
export function isValidRefName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= 200 &&
		!name.startsWith("-") &&
		!name.startsWith("/") &&
		!name.endsWith("/") &&
		!name.endsWith(".") &&
		!name.endsWith(".lock") &&
		!name.includes("..") &&
		!name.includes("//") &&
		!name.includes("@{") &&
		name !== "@" &&
		!/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
		!name.split("/").some(part => part.startsWith("."))
	);
}

/** True when `child` is strictly inside `root` (both already real paths). */
export function isInside(root: string, child: string): boolean {
	const relative = path.relative(root, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Lowercase, spaces→`-`, strip everything outside [a-z0-9-], collapse runs, trim dashes. */
export function slugifyName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Slug for a GUI worktree name, or null when the raw name has disallowed characters. */
export function worktreeSlug(raw: string): string | null {
	const slug = slugifyName(raw);
	if (/[^a-z0-9 -]/i.test(raw) || !WORKTREE_NAME_PATTERN.test(slug)) return null;
	return slug;
}
