import { mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoreError, core } from "../core/process";
import { SerialChain } from "../serial-chain";
import { itWithFileSymlinks } from "../test-symlinks";
import { withCompiledLauncherAside } from "./compiled-launcher";

const original = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
let root: string;
let bin: string;
let launcher: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-launcher-repair-"));
	bin = join(root, "bin");
	launcher = join(bin, "omp");
	await mkdir(bin);
	await writeFile(launcher, original);
});
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

/** Fault only the delivery of the real core's answer, after it moved the real file. */
function afterRename(intercept: () => Promise<void>) {
	const client = core();
	const call = client.call.bind(client);
	vi.spyOn(client, "call").mockImplementation(async (method, ...rest) => {
		const answer = await call(method, ...rest);
		if (method === "setup.setAsideCompiledOmp" && answer.result === true) await intercept();
		return answer;
	});
}

async function backup(): Promise<string> {
	const names = (await readdir(bin)).filter(name => /^omp\.ompdesk-compiled-42-\d+$/.test(name));
	expect(names).toHaveLength(1);
	return join(bin, names[0]);
}

it("restores the original when the core's rename succeeded but its reply was lost", async () => {
	afterRename(async () => {
		expect(await readFile(await backup())).toEqual(original);
		throw new CoreError("core_exited", "lost rename reply");
	});
	const install = vi.fn();
	await expect(withCompiledLauncherAside(root, "darwin", 42, install)).rejects.toThrow("lost rename reply");
	expect(install).not.toHaveBeenCalled();
	expect(await readdir(bin)).toEqual(["omp"]);
	expect(await readFile(launcher)).toEqual(original);
});

it("keeps both files if another launcher appears before a lost rename reply", async () => {
	afterRename(async () => {
		await writeFile(launcher, "another install");
		throw new CoreError("core_exited", "lost rename reply");
	});
	await expect(withCompiledLauncherAside(root, "darwin", 42, vi.fn())).rejects.toThrow("lost rename reply");
	expect(await readFile(launcher, "utf8")).toBe("another install");
	// A later install must not mistake the interrupted attempt for a discarded executable.
	await withCompiledLauncherAside(root, "darwin", 43, async () => ({ kind: "succeeded" }));
	expect(await readFile(await backup())).toEqual(original);
});

itWithFileSymlinks("keeps a dangling destination link and the backup during rollback", async () => {
	const missing = join(bin, "missing");
	await withCompiledLauncherAside(root, "darwin", 42, async () => {
		await symlink(missing, launcher, "file");
		return { kind: "cancelled" };
	});
	expect(await readlink(launcher)).toBe(missing);
	expect(await readFile(await backup())).toEqual(original);
});

it("does not overwrite a backup with the same timestamp", async () => {
	const aside = `${launcher}.ompdesk-compiled-42`;
	await writeFile(aside, "earlier backup");
	await withCompiledLauncherAside(root, "darwin", 42, async () => ({ kind: "cancelled" }));
	expect(await readFile(launcher)).toEqual(original);
	expect(await readFile(aside, "utf8")).toBe("earlier backup");
});

it("holds the next install until a stalled rename has restored its launcher", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const renamed = Promise.withResolvers<void>();
	const reply = Promise.withResolvers<void>();
	afterRename(() => {
		renamed.resolve();
		return reply.promise;
	});
	const queue = new SerialChain({ name: "test setup", maxStepMs: 100, log: () => {} });
	const install = vi.fn();
	const stalled = expect(queue.run(() => withCompiledLauncherAside(root, "darwin", 42, install))).rejects.toThrow(
		"was stopped",
	);
	await renamed.promise;
	await vi.advanceTimersByTimeAsync(100);
	await stalled;
	const next = queue.run(async () => {
		expect(await readFile(launcher)).toEqual(original);
		await writeFile(launcher, "replacement");
	});
	try {
		expect(queue.held).toBe(true);
	} finally {
		reply.resolve();
	}
	await next;
	expect(install).not.toHaveBeenCalled();
	expect(await readFile(launcher, "utf8")).toBe("replacement");
	expect(await readdir(bin)).toEqual(["omp"]);
});

it("does not sweep an orphaned aside when there is no launcher", async () => {
	const aside = `${launcher}.ompdesk-compiled-41`;
	await writeFile(aside, original);
	await rm(launcher);
	await withCompiledLauncherAside(root, "darwin", 42, async () => {
		await writeFile(launcher, "replacement");
		return { kind: "succeeded" };
	});
	expect(await readFile(aside)).toEqual(original);
});
