interface DelimitedTable {
	rows: string[][];
	/** Rows past `maxRows` exist and were not parsed. */
	clipped: boolean;
}

/**
 * Parse CSV/TSV: fields may be quoted ("a, b"), quotes double inside quotes
 * (""), and a quoted field may span lines. CRLF and LF both end a row.
 * Stops after `maxRows` rows.
 */
export function parseDelimited(text: string, delimiter: string, maxRows: number): DelimitedTable {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let i = 0;
	const endRow = () => {
		row.push(field);
		rows.push(row);
		row = [];
		field = "";
	};
	while (i < text.length) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				quoted = false;
			} else {
				field += ch;
			}
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			quoted = true;
		} else if (ch === delimiter) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			endRow();
			if (rows.length >= maxRows) return { rows, clipped: i + 1 < text.length };
		} else {
			field += ch;
		}
		i++;
	}
	if (field !== "" || row.length > 0) endRow();
	return { rows, clipped: false };
}
