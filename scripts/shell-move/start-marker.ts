export function rollbackStartMarker(
	raw: string | undefined,
	releasedVersion: string,
	running: readonly { id: number; name: string }[],
): { marker: unknown; valid: boolean } {
	if (raw === undefined) return { marker: null, valid: true };
	let marker: unknown;
	try {
		marker = JSON.parse(raw);
	} catch {
		return { marker: null, valid: false };
	}
	const valid =
		typeof marker === "object" &&
		marker !== null &&
		"version" in marker &&
		"pid" in marker &&
		marker.version === releasedVersion &&
		typeof marker.pid === "number" &&
		running.some(process_ => process_.id === marker.pid && process_.name.toLowerCase() === "ompdesk");
	return { marker, valid };
}
