import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sha = /^[0-9a-f]{40}$/;
const failed = run => run?.status === "completed" && (run.conclusion === "failure" || run.conclusion === "cancelled");

function entries(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

function legacyClaim(dir, contains) {
	let legacy;
	for (const entry of entries(dir)) {
		if (!sha.test(entry.name)) continue;
		const inBatch = contains(entry.name);
		if (inBatch === false) continue;
		if (inBatch !== true || !entry.isDirectory() || legacy) throw Error(`ambiguous legacy Windows claim in ${dir}`);
		legacy = entry.name;
	}
	return legacy;
}

function pins(dir) {
	const history = entries(dir)
		.sort((a, b) => Number(a.name) - Number(b.name))
		.map((entry, i) => {
			if (!entry.isFile() || entry.name !== String(i)) throw Error(`invalid Windows batch slot in ${dir}`);
			const candidate = readFileSync(join(dir, entry.name), "utf8");
			if (!sha.test(candidate)) throw Error(`invalid Windows batch candidate in ${dir}/${i}`);
			return candidate;
		});
	if (new Set(history).size !== history.length) throw Error(`repeated Windows batch candidate in ${dir}`);
	return history;
}

// Linking a completed file leaves neither a partial pointer nor an overwrite window for a competing publisher.
function append(dir, slot, candidate) {
	const tmp = join(dir, `.pin-${randomUUID()}`);
	writeFileSync(tmp, candidate, { flag: "wx", mode: 0o600 });
	try {
		linkSync(tmp, slot);
		return true;
	} catch (error) {
		if (error.code === "EEXIST") return readFileSync(slot, "utf8") === candidate;
		throw error;
	} finally {
		unlinkSync(tmp);
	}
}

export function selectWindowsBatch({ dir, base, tip, contains, receipt }) {
	if (!sha.test(base) || !sha.test(tip)) throw Error("invalid Windows batch revision");
	const batch = join(dir, "batches", base);
	const history = pins(batch);
	const legacy = legacyClaim(dir, contains);
	if (legacy && history.length && history[0] !== legacy) throw Error(`conflicting legacy Windows claim for ${base}`);
	if (history.some(pin => contains(pin) !== true) || (tip !== base && contains(tip) !== true))
		throw Error(`Windows batch candidate outside the current dev ancestry for ${base}`);

	const current = history.at(-1) ?? legacy;
	const candidate = !current || (tip !== current && failed(receipt(current))) ? tip : current;
	const plan = [...history];
	if (!plan.length && legacy) plan.push(legacy);
	if (plan.at(-1) !== candidate) plan.push(candidate);
	return {
		candidate,
		claim() {
			if (candidate === base || candidate === legacy || legacyClaim(dir, contains) !== legacy) return false;
			const now = pins(batch);
			if (now.length < history.length) throw Error(`missing Windows batch slot for ${base}`);
			if (now.some((pin, i) => pin !== plan[i])) return false;
			if (now.length === plan.length) return true;
			if (current && current !== candidate && !failed(receipt(current))) return false;
			mkdirSync(batch, { recursive: true });
			for (let i = now.length; i < plan.length; i++) {
				if (!append(dir, join(batch, String(i)), plan[i])) return false;
			}
			return true;
		},
	};
}
