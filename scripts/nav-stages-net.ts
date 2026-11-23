// Chromium's unbounded JSON NetLog writes the constants and one event per line, before writing its footer on close.
const load = "COOKIE_PERSISTENT_STORE_LOAD";
const bootstrapPhases = [
	"REQUEST_ALIVE",
	"URL_REQUEST_START_JOB",
	"URL_REQUEST_REDIRECTED",
	"CANCELLED",
	"FAILED",
	"PROXY_RESOLUTION_SERVICE",
	"PROXY_RESOLUTION_SERVICE_WAITING_FOR_INIT_PAC",
	"PROXY_RESOLUTION_SERVICE_RESOLVED_PROXY_LIST",
	"HTTP_STREAM_REQUEST",
	"HTTP_TRANSACTION_SEND_REQUEST",
	"HTTP_TRANSACTION_READ_HEADERS",
	"URL_REQUEST_DELEGATE_BEFORE_URL_REQUEST",
];
const initPhases = [
	"PAC_FILE_DECIDER",
	"PAC_FILE_DECIDER_WAIT",
	"PAC_FILE_DECIDER_FETCH_PAC_SCRIPT",
	"PAC_FILE_DECIDER_FALLING_BACK_TO_NEXT_PAC_SOURCE",
];
const names = [load, ...bootstrapPhases, ...initPhases];

export function integer(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function tick(value: unknown): number | null {
	return integer(typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value);
}

type NetEvent = {
	name: string;
	source: number;
	phase: number;
	tick: number;
	at: number | null;
	netError: number | null;
};
export type NetTrace = {
	state: "missing" | "partial" | "closed" | "unreadable";
	clock: boolean;
	phases: NetEvent[];
	bootstrap: Map<number, number | null>;
};

export async function readNet(lines: AsyncIterable<string> | Iterable<string>): Promise<NetTrace> {
	const trace: NetTrace = { state: "partial", clock: false, phases: [], bootstrap: new Map() };
	const types = new Map<number, string>();
	let offset: number | null = null;
	let events = false,
		footer = false,
		closed = false,
		damaged = false;
	try {
		for await (const raw of lines) {
			let s = raw.trim();
			if (!s) continue;
			if (!events) {
				if (/^\{?\s*"constants"\s*:/.test(s)) {
					const constants = JSON.parse(s.slice(s.indexOf(":") + 1).replace(/,$/, ""));
					offset = tick(constants?.timeTickOffset);
					trace.clock = offset !== null;
					for (const name of names) {
						const id = integer(constants?.logEventTypes?.[name]);
						if (id !== null) types.set(id, name);
					}
				} else if (/^"events"\s*:\s*\[$/.test(s)) events = true;
				continue;
			}
			if (footer) {
				if (s === "}") closed = true;
				continue;
			}
			// On close Chromium overwrites the last comma/newline with ] and optional polledData.
			const tail = /\]\s*(,|\})?$/.exec(s);
			if (tail) {
				footer = true;
				closed = tail[1] === "}";
				s = s.slice(0, tail.index).trimEnd();
			}
			if (!s) continue;
			let row: {
				type: number;
				time?: unknown;
				source?: { id?: unknown };
				phase?: unknown;
				params?: { url?: unknown; net_error?: unknown };
			} | null;
			try {
				row = JSON.parse(s.replace(/,$/, ""));
			} catch {
				damaged = true;
				continue;
			}
			const source = integer(row?.source?.id),
				time = tick(row?.time),
				phase = integer(row?.phase);
			if (source === null || time === null || phase === null || phase < 0 || phase > 2) continue;
			const at = offset === null ? null : time + offset;
			if (
				typeof row?.params?.url === "string" &&
				/^http:\/\/app\.localhost\/__profile\/migrate(?:[?#]|$)/.test(row.params.url) &&
				!trace.bootstrap.has(source)
			) {
				trace.bootstrap.set(source, at);
			}
			const name = row && types.get(row.type);
			if (name)
				trace.phases.push({ name, source, phase, tick: time, at, netError: integer(row?.params?.net_error) });
		}
		if (closed && !damaged && types.size) trace.state = "closed";
	} catch {
		trace.state = "unreadable";
	}
	trace.phases = trace.phases.filter(
		row => row.name === load || initPhases.includes(row.name) || trace.bootstrap.has(row.source),
	);
	return trace;
}

type CookieLoad = { source: number; beginAt: number | null; endAt: number | null };
export function cookieLoads(trace: NetTrace): CookieLoad[] {
	const loads: CookieLoad[] = [];
	const pending = new Map<number, CookieLoad>();
	for (const row of trace.phases) {
		if (row.name !== load) continue;
		if (row.phase === 1) {
			const span = { source: row.source, beginAt: row.at, endAt: null };
			loads.push(span);
			pending.set(row.source, span);
		} else if (row.phase === 2) {
			const span = pending.get(row.source);
			if (span) span.endAt = row.at;
			else loads.push({ source: row.source, beginAt: null, endAt: row.at });
			pending.delete(row.source);
		}
	}
	return loads;
}
