import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { cargoEnv, cargoPath } from "../../scripts/cargo";

const cwd = resolve("native/ompdesk/crates/tauri-shell/tests/policy");
let binary: Promise<string> | undefined;

async function build(): Promise<string> {
	const staged = process.env.OMPDESK_TEST_SHELL_POLICY;
	if (staged) return staged;
	const cargo = cargoPath(cwd);
	if (!cargo) throw new Error("Cargo is required for shell policy parity");
	const { stdout } = await promisify(execFile)(cargo, ["build", "--locked", "--message-format=json"], {
		cwd,
		env: cargoEnv(cargo),
		windowsHide: true,
	});
	for (const line of stdout.trim().split("\n")) {
		const artifact = JSON.parse(line) as { executable?: string; target?: { name?: string } };
		if (artifact.target?.name === "shell-policy-fixture" && artifact.executable) return artifact.executable;
	}
	throw new Error("Cargo did not build shell-policy-fixture");
}

function fixtureBinary(): Promise<string> {
	binary ??= build();
	return binary;
}

export async function prepareShellPolicyFixture(): Promise<void> {
	await fixtureBinary();
}

export interface ShellPolicyFixture {
	call<T>(method: string, params?: object): Promise<T>;
	close(): Promise<void>;
}

export async function shellPolicyFixture(): Promise<ShellPolicyFixture> {
	const child = spawn(await fixtureBinary(), [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
	const { promise: closed, resolve: didClose } = Promise.withResolvers<number | null>();
	child.once("close", didClose);
	const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
	await once(child, "spawn");
	return {
		async call<T>(method: string, params: object = {}): Promise<T> {
			child.stdin.write(`${JSON.stringify({ method, params })}\n`);
			const next = await lines.next();
			if (next.done) throw new Error(`shell-policy-fixture exited during ${method} (${await closed})`);
			return JSON.parse(next.value) as T;
		},
		async close(): Promise<void> {
			child.stdin.end();
			const code = await closed;
			if (code !== 0) throw new Error(`shell-policy-fixture exited (${code})`);
		},
	};
}
