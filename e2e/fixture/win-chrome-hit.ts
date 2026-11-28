/** Playwright runs under Node. This short-lived Bun process queries only its fixture's top-level HWND. */
import { dlopen, ptr, FFIType as T } from "bun:ffi";

const { symbols: win } = dlopen("user32.dll", {
	GetWindowThreadProcessId: { args: [T.u64, T.ptr], returns: T.u32 },
	SetThreadDpiAwarenessContext: { args: [T.i64], returns: T.i64 },
	ClientToScreen: { args: [T.u64, T.ptr], returns: T.i32 },
	IsIconic: { args: [T.u64], returns: T.i32 },
	IsZoomed: { args: [T.u64], returns: T.i32 },
	SendMessageTimeoutW: { args: [T.u64, T.u32, T.u64, T.i64, T.u32, T.u32, T.ptr], returns: T.i64 },
});
const { hwnd, pid, scale, points } = JSON.parse(process.argv[2]) as {
	hwnd: number;
	pid: number;
	scale: number;
	points?: Record<string, { x: number; y: number }>;
};
const handle = BigInt(hwnd);
const owner = Buffer.alloc(4);
if (!win.GetWindowThreadProcessId(handle, ptr(owner)) || owner.readUInt32LE() !== pid)
	throw new Error(`HWND ${hwnd} does not belong to the test shell PID ${pid}`);
if (!points) {
	process.stdout.write(win.IsIconic(handle) ? "minimized" : win.IsZoomed(handle) ? "maximized" : "normal");
	process.exit(0);
}
// Per-monitor V2 prevents ClientToScreen from returning virtualized coordinates on scaled monitors.
if (!win.SetThreadDpiAwarenessContext(-4n)) throw new Error("Cannot set per-monitor DPI awareness");
const origin = Buffer.alloc(8);
if (!win.ClientToScreen(handle, ptr(origin))) throw new Error("Cannot locate the test window's client area");
const x0 = origin.readInt32LE();
const y0 = origin.readInt32LE(4);
const result = Buffer.alloc(8);
const hits: Record<string, number> = {};
for (const [name, point] of Object.entries(points)) {
	const x = x0 + Math.round(point.x * scale);
	const y = y0 + Math.round(point.y * scale);
	const lParam = BigInt(((y & 0xffff) << 16) | (x & 0xffff));
	// WM_NCHITTEST is a read, not a mouse event. SMTO_ABORTIFHUNG bounds a stalled window procedure.
	if (!win.SendMessageTimeoutW(handle, 0x84, 0n, lParam, 2, 1000, ptr(result)))
		throw new Error(`WM_NCHITTEST did not return at ${name} (${x}, ${y})`);
	hits[name] = Number(result.readBigInt64LE());
}
process.stdout.write(JSON.stringify({ origin: { x: x0, y: y0 }, maximized: !!win.IsZoomed(handle), hits }));
