type MountedEntry = { name: string; summary: string };

/** Stock renamed mounted devices to tool commands in 19.1; their catalog entries kept the same shape. */
export function mountedToolEntries(
	session: { getToolCommandEntries(): MountedEntry[] } | { getXdevToolEntries(): MountedEntry[] },
): MountedEntry[] {
	return "getToolCommandEntries" in session ? session.getToolCommandEntries() : session.getXdevToolEntries();
}
