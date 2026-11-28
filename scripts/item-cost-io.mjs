// strace -ff keeps resumed calls from different threads out of one another's lines. -y resolves the actual fd path.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const traceArgs = prefix => [
	"-ff",
	"-qq",
	"-ttt",
	"-T",
	"-y",
	"-s",
	"0",
	"-o",
	prefix,
	"-e",
	"trace=read,write,pread64,pwrite64,readv,writev,fsync,fdatasync,ftruncate",
];

// Only successful I/O on the isolated profile during the measured wall-clock interval. Counts the kernel's
// return values, not requested lengths, file growth, block-device writes or calls to sqlite3_vfs.xWrite.
export function fileIo(dir, start, end) {
	const files = {};
	for (const trace of readdirSync(dir).filter(f => f.startsWith("syscalls."))) {
		for (const line of readFileSync(join(dir, trace), "utf8").split("\n")) {
			const match = /^(\d+\.\d+) (\w+)\(\d+<([^>]+)>.*\)\s+= (\d+)\s+<(\d+\.\d+)>$/.exec(line);
			if (!match) continue;
			const [, ts, op, path, result, seconds] = match;
			if (+ts < start || +ts > end || !(path === dir || path.startsWith(`${dir}/`))) continue;
			const key = path === dir ? "directory" : basename(path);
			files[key] ??= {
				readBytes: 0,
				writeBytes: 0,
				reads: 0,
				writes: 0,
				syncs: 0,
				truncates: 0,
				syscallMicros: 0,
			};
			const count = files[key];
			count.syscallMicros += Math.round(+seconds * 1e6); // Traced syscall time, not untraced commit latency.
			if (op.includes("read")) {
				count.readBytes += +result;
				count.reads++;
			} else if (op.includes("write")) {
				count.writeBytes += +result;
				count.writes++;
			} else if (op === "ftruncate") count.truncates++;
			else count.syncs++;
		}
	}
	assert(
		Object.values(files).some(row => row.writeBytes > 0),
		"no completed profile write in the trace",
	);
	return files;
}
