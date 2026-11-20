import { describe, expect, it } from "vitest";
import { DeviceSectionOrder } from "./device-section-order";

const a = "a".repeat(26);
const b = "b".repeat(26);
const c = "c".repeat(26);
const d = "d".repeat(26);
const viewer = "v".repeat(26);
const local = "local";

function device(id: string, prefs = new Map<string, unknown>()): DeviceSectionOrder {
	return new DeviceSectionOrder(id, prefs, prefs.get("sidebarFolds"));
}

describe("shared device section order", () => {
	it("leaves an untouched order unranked, even across a read, an empty legacy migration and an empty edit", () => {
		const prefs = new Map<string, unknown>([["sidebarFolds", { deviceOrder: [], knownHosts: [{ id: b }] }]]);
		const model = device(a, prefs);
		model.migrate([b]);
		expect(model.view([c, b])).toEqual([]);
		expect(model.set([], [c, b])).toBe(false);
		expect(model.merge([])).toBe(false);
		expect(model.wire()).toEqual([]);
		expect([...prefs.keys()]).toEqual(["sidebarFolds"]);
	});

	it("imports a saved order once, after the paired hosts are known, without admitting cached names or paths", () => {
		const name = "Studio downstairs";
		const path = "/Users/work/private";
		const prefs = new Map<string, unknown>([
			[
				"sidebarFolds",
				{
					deviceOrder: [name, c, b, b, path, local, d],
					knownHosts: [
						{ id: c, name },
						{ id: path, name },
						{ id: d, name: "offline" },
					],
				},
			],
		]);
		const model = device(a, prefs);
		expect(model.view([])).toEqual([]);
		model.migrate([b, d]);
		expect(model.view([b])).toEqual([b, local]);
		expect(model.view([d, c, b])).toEqual([b, local, d, c]);
		const payload = JSON.stringify(model.wire());
		for (const text of [a, b, c, d, local, name, path, "knownHosts"]) expect(payload).not.toContain(text);
		expect(model.wire()).toHaveLength(3);
		const remote = device(b);
		expect(remote.merge(JSON.parse(payload))).toBe(true);
		expect(remote.view([c, a, d])).toEqual([local, a, d, c]);
		prefs.set("sidebarFolds", { deviceOrder: [c, d, b, local] });
		model.migrate([c, d, b]);
		const reopened = device(a, prefs);
		reopened.migrate([c, d, b]);
		expect(reopened.wire()).toEqual(model.wire());
		expect(reopened.view([c, d, b])).toEqual([b, local, d, c]);
	});

	it("prefers a real edit to either host's legacy order, regardless of delivery order", () => {
		const desktop = device(a, new Map([["sidebarFolds", { deviceOrder: [b, local] }]]));
		const laptop = device(b);
		laptop.set([a, local], [a]);
		const modern = laptop.wire();
		desktop.migrate([b]);
		expect(laptop.merge(desktop.wire())).toBe(false);
		expect(desktop.merge(modern)).toBe(true);
		expect(desktop.view([b])).toEqual([local, b]);
		const late = device(b, new Map([["sidebarFolds", { deviceOrder: [local, a] }]]));
		late.merge(modern);
		late.migrate([a]);
		expect(late.wire()).toEqual(modern);
	});

	it("relays an unseen host's slot without displaying its id and translates local on each computer", () => {
		const source = device(a);
		const relay = device(b);
		const end = device(c);
		source.set([local, c, b], [b, c]);
		expect(relay.merge(source.wire())).toBe(true);
		expect(relay.view([a])).toEqual([a, local]);
		expect(relay.set([local, a], [a])).toBe(true);
		expect(relay.set([local, a], [a])).toBe(false);
		expect(end.merge(relay.wire())).toBe(true);
		expect(end.view([b])).toEqual([b, local]);
		expect(source.merge(end.wire())).toBe(true);
		expect(source.view([b, c])).toEqual([b, c, local]);
		expect(end.view([b, a, c])).toEqual([b, local, a]);
		expect(relay.merge(end.wire())).toBe(false);
	});

	it("appends unranked devices by their stable ids regardless of discovery order, including an unranked self", () => {
		const desktop = device(a);
		const laptop = device(d);
		desktop.set([local], []);
		laptop.merge(desktop.wire());
		const actual = desktop.view([d, c, b]).map(id => (id === local ? a : id));
		expect(actual).toEqual([a, b, c, d]);
		expect(laptop.view([b, c, a])).toEqual([a, b, c, local]);
		expect(laptop.view([b, c, a]).map(id => (id === local ? d : id))).toEqual(actual);
		expect(laptop.view([b, c])).toEqual([b, c, local]);
		expect(laptop.set([b, c, local], [b, c])).toBe(false);
		expect(laptop.wire()).toEqual(desktop.wire());
		expect(laptop.set([local, b], [a, c, b])).toBe(true);
		expect(laptop.view([a, b, c])).toEqual([a, local, c, b]);
	});

	it("adds newly ranked devices without moving omitted or offline sections out of their slots", () => {
		const model = device(a);
		model.set([b, local, c], [b, c]);
		expect(model.set([d, b], [b, d])).toBe(true);
		expect(model.view([b, c, d, viewer])).toEqual([d, local, c, b, viewer]);
		expect(model.set([local, b], [b])).toBe(false);
		expect(model.view([c, d])).toEqual([d, local, c]);
	});

	it("resolves equal clocks by writer rather than arrival order and ignores duplicate or reordered snapshots", () => {
		const first = device(a);
		first.set([b, local, c], [b, c]);
		const second = device(b);
		second.set([c, local, a], [a, c]);
		const forward = device(viewer);
		const reverse = device(d);
		forward.merge(first.wire());
		forward.merge(second.wire());
		reverse.merge(second.wire());
		reverse.merge(first.wire());
		const order = forward.view([a, b, c]);
		expect([
			[b, a, c, local],
			[c, b, a, local],
		]).toContainEqual(order);
		expect(reverse.view([a, b, c])).toEqual(order);
		expect(reverse.wire()).toEqual(forward.wire());
		expect(forward.merge([...reverse.wire()].reverse())).toBe(false);
		expect(reverse.merge(first.wire())).toBe(false);
	});

	it("preserves simultaneous disjoint moves even when four previously isolated devices claimed the same slot", () => {
		const left = device(viewer);
		const right = device("w".repeat(26));
		const hosts = [a, b, c, d];
		for (const id of hosts) {
			const isolated = device(id);
			isolated.set([local], []);
			left.merge(isolated.wire());
		}
		right.merge(left.wire());
		const initial = left.view(hosts);
		const [one, two, three, four] = initial;
		expect(left.set([three, one], hosts)).toBe(true);
		expect(left.view(hosts)).toEqual([three, two, one, four, local]);
		expect(right.set([four, two], hosts)).toBe(true);
		expect(right.view(hosts)).toEqual([one, four, three, two, local]);
		const rightOnly = right.wire();
		expect(right.merge(left.wire())).toBe(true);
		expect(left.merge(rightOnly)).toBe(true);
		expect(right.view(hosts)).toEqual([three, four, one, two, local]);
		expect(left.wire()).toEqual(right.wire());
	});

	it("restores the greatest observed logical clock so the next edit wins after restart and an old retry loses", () => {
		const first = device(a);
		first.set([local, b], [b]);
		first.set([b, local], [b]);
		first.set([local, b], [b]);
		const old = first.wire();
		const prefs = new Map<string, unknown>();
		device(b, prefs).merge(old);
		const reopened = device(b, prefs);
		expect(reopened.view([a])).toEqual([a, local]);
		expect(reopened.set([local, a], [a])).toBe(true);
		expect(first.merge(reopened.wire())).toBe(true);
		expect(first.view([b])).toEqual([b, local]);
		expect(device(b, prefs).merge(old)).toBe(false);
	});

	it("rejects unknown or duplicate UI ids and malformed wire snapshots without accepting their valid prefix", () => {
		const model = device(a);
		model.set([local, b], [b]);
		const saved = model.wire();
		for (const order of [null, {}, "local", [false], [local, local], [a], [c], ["Studio"], ["/private"]]) {
			expect(() => model.set(order, [a, b, "Studio", "/private"])).toThrow();
		}
		const incoming = device(c);
		incoming.set([local], []);
		const good = incoming.wire()[0]!;
		const [key, , , writer] = saved[0]!;
		for (const bad of [
			null,
			{},
			[],
			[a, 0, 1, writer],
			[local, 0, 1, writer],
			[key, 0, 1, b],
			[key, -1, 1, writer],
			[key, 0.5, 1, writer],
			[key, 0, Infinity, writer],
			[key, 0, Number.MAX_SAFE_INTEGER, writer],
			[key, 0, 1, writer, "private"],
			good,
		])
			expect(model.merge([good, bad])).toBe(false);
		for (const bad of [null, "", {}, new Array(1000).fill(good)]) expect(model.merge(bad)).toBe(false);
		expect(model.wire()).toEqual(saved);
		expect(model.view([c, b])).toEqual([local, b, c]);
	});

	it("keeps the same bounded state when two full histories meet through different relays", () => {
		const one = device(a);
		const two = device(b);
		const ids = Array.from({ length: 512 }, (_, i) => i.toString(36).padStart(26, "0"));
		one.set(ids.slice(0, 256), ids);
		two.set(ids.slice(256), ids);
		const older = one.wire();
		const newer = two.wire();
		one.merge(newer);
		two.merge(older);
		expect(one.wire()).toHaveLength(256);
		expect(two.wire()).toEqual(one.wire());
		expect(one.merge(older)).toBe(false);
		expect(two.merge(newer)).toBe(false);
	});
});
