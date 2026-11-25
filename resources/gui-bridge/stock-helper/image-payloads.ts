/** Only these journal positions carry pictures on the paired-device and web links. */
export function isImagePosition(record: Record<string, unknown>, key: string | undefined): boolean {
	if (key === "content") return record.type === "image";
	return (
		key === "images" &&
		(record.type === "image" || (typeof record.mimeType === "string" && record.mimeType.startsWith("image/")))
	);
}

/** Copy changed paths only; skipped records and unchanged payloads keep their identity. */
export function mapImagePayloads<T>(
	value: T,
	swap: (record: Record<string, unknown>, data: string) => Record<string, unknown> | null,
	skip?: (record: Record<string, unknown>) => boolean,
	key?: string,
): T {
	if (Array.isArray(value)) {
		let copy: unknown[] | null = null;
		value.forEach((item, index) => {
			const replaced = mapImagePayloads(item, swap, skip, key);
			if (replaced === item) return;
			copy ??= [...value];
			copy[index] = replaced;
		});
		return (copy ?? value) as T;
	}
	if (typeof value !== "object" || value === null) return value;
	const record = value as Record<string, unknown>;
	if (skip?.(record)) return value;
	if (typeof record.data === "string" && isImagePosition(record, key)) {
		return (swap(record, record.data) ?? value) as T;
	}
	let copy: Record<string, unknown> | null = null;
	for (const [childKey, child] of Object.entries(record)) {
		const replaced = mapImagePayloads(child, swap, skip, childKey);
		if (replaced === child) continue;
		copy ??= { ...record };
		copy[childKey] = replaced;
	}
	return (copy ?? value) as T;
}
