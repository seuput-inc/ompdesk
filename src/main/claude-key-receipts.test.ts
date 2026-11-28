import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-key-receipts-"));
	onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
	const setup = `
		import assert from 'node:assert/strict';
		import { bindConfirmedReplacement, confirmKeyReceipt, currentKeyGeneration, forgetKeyReceipt, keyReceipt, registerKeyReceipt }
			from './resources/gui-bridge/claude-key-receipts.ts';
		const dir = ${JSON.stringify(dir)}, p = 'anthropic-api-key', q = 'anthropic-api-key-2';
		const a = 'a'.repeat(64), b = 'b'.repeat(64);
	`;
	function probe(body: string, crash = false) {
		const ran = spawnSync("bun", ["-e", setup + body], { encoding: "utf8", timeout: 5000 });
		expect(ran.error).toBeUndefined();
		if (crash && process.platform !== "win32") expect(ran.signal, ran.stderr).toBe("SIGKILL");
		else expect(ran.status, ran.stderr).toBe(crash ? 73 : 0);
	}
	return { dir, probe };
}

it("opens a legacy binding without importing seed IDs and reopens the last confirmation after a process dies", () => {
	const { dir, probe } = fixture();
	probe(`
		assert.equal(currentKeyGeneration(dir, p, a), undefined);
		confirmKeyReceipt(dir, p, a, 'gone', 10, ['unbound']);
		forgetKeyReceipt(dir, p);
	`);
	expect(readdirSync(dir)).toEqual([]);
	writeFileSync(join(dir, "models.yml"), "providers:\n  anthropic-api-key:\n    models:\n      - id: seed-only\n");
	probe(
		`
		const first = keyReceipt(dir, p, a);
		assert.ok(first.generation);
		assert.deepEqual(first, {generation: first.generation, models: []});
		assert.deepEqual(keyReceipt(dir, p, a), first);
		confirmKeyReceipt(dir, p, a, first.generation, 20, ['current', 'another']);
		confirmKeyReceipt(dir, p, a, first.generation, 10, ['older']);
		if (process.platform === 'win32') process.exit(73);
		process.kill(process.pid, 'SIGKILL');
	`,
		true,
	);
	probe(`
		const generation = currentKeyGeneration(dir, p, a);
		assert.ok(generation);
		assert.deepEqual(keyReceipt(dir, p, a), {generation, confirmedAt: 20, models: ['current', 'another']});
	`);
	if (process.platform !== "win32")
		expect(statSync(join(dir, "ompdesk-claude-key-receipts.sqlite")).mode & 0o077).toBe(0);
});

it("keeps a replacement intact when a stale session opens the previous fingerprint or confirms an old GET", () => {
	const { probe } = fixture();
	probe(`
		registerKeyReceipt(dir, p, a, 10, ['before']);
		const old = keyReceipt(dir, p, a).generation;
		const edited = 'c'.repeat(64);
		const lookup = keyReceipt(dir, p, edited);
		assert.deepEqual(lookup, {generation: '', replacedGeneration: old, models: []});
		registerKeyReceipt(dir, p, b, 20, ['replacement']);
		const current = currentKeyGeneration(dir, p, b);
		assert.ok(current);
		assert.notEqual(current, old);
		assert.equal(currentKeyGeneration(dir, p, a), undefined);
		assert.deepEqual(keyReceipt(dir, p, a), {generation: '', replacedGeneration: current, models: []});
		assert.equal(bindConfirmedReplacement(dir, p, edited, lookup.replacedGeneration, 30, ['late']), undefined);
		confirmKeyReceipt(dir, p, a, '', 30, ['unbound']);
		confirmKeyReceipt(dir, p, a, current, 30, ['wrong-key']);
		confirmKeyReceipt(dir, p, b, old, 30, ['wrong-generation']);
		assert.deepEqual(keyReceipt(dir, p, b), {generation: current, confirmedAt: 20, models: ['replacement']});
	`);
});

it("binds a confirmed manual replacement only to the generation it observed", () => {
	const { probe } = fixture();
	probe(`
		registerKeyReceipt(dir, p, a, 10, ['before']);
		const {replacedGeneration} = keyReceipt(dir, p, b);
		assert.ok(replacedGeneration);
		assert.equal(bindConfirmedReplacement(dir, p, a, replacedGeneration, 15, ['same-key']), undefined);
		const next = bindConfirmedReplacement(dir, p, b, replacedGeneration, 20, ['new']);
		assert.ok(next);
		assert.notEqual(next, replacedGeneration);
		assert.deepEqual(keyReceipt(dir, p, b), {generation: next, confirmedAt: 20, models: ['new']});
		confirmKeyReceipt(dir, p, a, replacedGeneration, 30, ['old']);
		assert.equal(bindConfirmedReplacement(dir, p, a, replacedGeneration, 40, ['revived']), undefined);
		assert.deepEqual(keyReceipt(dir, p, b), {generation: next, confirmedAt: 20, models: ['new']});
	`);
});

it("fences a late confirmation across deletion and re-registration of the same key without touching its sibling", () => {
	const { probe } = fixture();
	probe(`
		registerKeyReceipt(dir, p, a, 10, ['first']);
		registerKeyReceipt(dir, q, a, 15, ['sibling']);
		const first = keyReceipt(dir, p, a), sibling = keyReceipt(dir, q, a);
		forgetKeyReceipt(dir, p);
		confirmKeyReceipt(dir, p, a, first.generation, 60, ['deleted']);
		assert.equal(currentKeyGeneration(dir, p, a), undefined);
		registerKeyReceipt(dir, p, a, 20, ['re-added']);
		const second = keyReceipt(dir, p, a);
		assert.notEqual(second.generation, first.generation);
		confirmKeyReceipt(dir, p, a, first.generation, 60, ['late']);
		assert.deepEqual(keyReceipt(dir, p, a), {generation: second.generation, confirmedAt: 20, models: ['re-added']});
		registerKeyReceipt(dir, p, a, 30, ['registered-again']);
		assert.notEqual(currentKeyGeneration(dir, p, a), second.generation);
		assert.deepEqual(keyReceipt(dir, q, a), sibling);
	`);
});
