import { describe, expect, it } from "vitest";
import { rollbackStartMarker } from "./start-marker";

describe("rollback start marker", () => {
	const running = [{ id: 42, name: "OMPdesk", path: "C:\\test\\OMPdesk.exe" }];

	it.each(["0.127.0", "0.128.0", "0.131.0"])("accepts the running restored release %s", version => {
		const marker = { version, pid: 42, at: 1730000000000 };
		expect(rollbackStartMarker(JSON.stringify(marker), version, running)).toEqual({ marker, valid: true });
	});

	it("accepts an absent marker for older releases", () => {
		expect(rollbackStartMarker(undefined, "0.127.0", running)).toEqual({ marker: null, valid: true });
	});

	it("rejects the failed candidate's marker", () => {
		const marker = { version: "0.200.0", pid: 42, at: 1730000000000 };
		expect(rollbackStartMarker(JSON.stringify(marker), "0.131.0", running)).toEqual({ marker, valid: false });
	});

	it.each(["{", "null", "{}", '{"version":"0.131.0","pid":"42"}'])("rejects malformed marker %s", raw => {
		expect(rollbackStartMarker(raw, "0.131.0", running).valid).toBe(false);
	});

	it("rejects a PID that is not running or belongs to another process", () => {
		expect(rollbackStartMarker('{"version":"0.131.0","pid":43}', "0.131.0", running).valid).toBe(false);
		expect(rollbackStartMarker('{"version":"0.131.0","pid":42}', "0.131.0", [{ id: 42, name: "node" }]).valid).toBe(false);
	});
});
