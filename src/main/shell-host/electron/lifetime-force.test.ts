import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "vite";
import { expect, it } from "vitest";
import { DIES_WITH_TEST, ompRuns, RM_TEMP } from "../../test-fake-omp";
import { ShellClient } from "../client";

async function listen(server: Server, address: string | number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(address, () => {
		server.off("error", reject);
		resolve();
	});
	await promise;
}

function close(server: Server): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	return promise;
}

it.each(["socket", "stdin", "both"] as const)(
	"forces and joins its cores when shell %s closes",
	async shutdown => {
		const dir = await mkdtemp(join(tmpdir(), "omp-shell-life-"));
		const socketPath =
			process.platform === "win32" ? `\\\\.\\pipe\\ompdesk-shell-life-${randomUUID()}` : join(dir, "host.sock");
		const shellReady = Promise.withResolvers<ShellClient>();
		type Git = { socket: Socket; pid: number; term: boolean; closed: Promise<void> };
		const firstGitReady = Promise.withResolvers<Git>();
		const secondGitReady = Promise.withResolvers<Git>();
		const coreReady = Promise.withResolvers<number>();
		const nextCoreReady = Promise.withResolvers<number>();
		const stdinEnded = Promise.withResolvers<number | null>();
		const exitRequested = Promise.withResolvers<number>();
		const restartAttempt = Promise.withResolvers<number | null>();
		const lateAnswer = Promise.withResolvers<string>();
		const failed = Promise.withResolvers<never>();
		const sockets = new Set<Socket>();
		const gits: Git[] = [];
		let shell: ShellClient | undefined;
		const shellServer = createServer(socket => {
			shell = new ShellClient(socket);
			shell.handle("hello", () => ({
				protocol: 1,
				facts: {
					paths: { userData: dir },
					exe: process.execPath,
					resourcesPath: dir,
					appPath: dir,
					isPackaged: false,
					argv: [process.execPath],
					locale: { appLocale: "en", systemLocale: "en-US", preferredLanguages: ["en-US"] },
					displays: [],
					primaryDisplayId: 0,
					theme: { dark: false, highContrast: false, inverted: false },
					system: { reducedMotion: false, onBattery: false, online: true },
					versions: { chrome: "1", cef: "1", shell: "1" },
					safeStorage: { unavailable: "test" },
				},
			}));
			shell.handle("app.init", () => ({}));
			shellReady.resolve(shell);
		});
		const gitServer = createServer(socket => {
			sockets.add(socket);
			const closed = Promise.withResolvers<void>();
			socket.once("close", () => closed.resolve());
			let git: Git | undefined;
			createInterface({ input: socket }).on("line", line => {
				if (line.startsWith("ready:")) {
					git = { socket, pid: Number(line.slice(6)), term: false, closed: closed.promise };
					gits.push(git);
					if (gits.length === 1) firstGitReady.resolve(git);
					if (gits.length === 2) secondGitReady.resolve(git);
				} else if (line === "term" && git) {
					git.term = true;
				}
			});
		});
		let node: ChildProcess | undefined;
		let firstCore: number | undefined;
		let secondCore: number | undefined;
		let extraCore: number | undefined;
		let completed = false;
		try {
			await Promise.all([listen(shellServer, socketPath), listen(gitServer, 0)]);
			const gitAddress = gitServer.address();
			if (!gitAddress || typeof gitAddress === "string") throw new Error("git fixture has no TCP port");
			const gitScript = `${DIES_WITH_TEST}
const socket = require("node:net").connect(${gitAddress.port}, "127.0.0.1", () => socket.write("ready:" + process.pid + "\\n"));
${process.platform === "win32" ? "" : 'process.on("SIGTERM", () => socket.write("term\\n"));'}
socket.on("data", () => process.exit(0));`;
			const mainDir = join(__dirname, "..", "..");
			const fixture = join(dir, "main.ts");
			await writeFile(
				fixture,
				`import { core } from ${JSON.stringify(join(mainDir, "core", "process.ts"))};
import ${JSON.stringify(join(__dirname, "index.ts"))};
const instance = core();
const params = {
  root: ${JSON.stringify(dir)}, paths: null,
  git: { bin: process.execPath, args: ["-e", ${JSON.stringify(gitScript)}], env: process.env, timeoutMs: 600000, maxBytes: 1024 }
};
function startGit() {
  void instance.call("git.stage", params).catch(error => {
    if (error.code !== "cancelled" && error.code !== "core_exited") process.send?.({ error: String(error) });
  });
  return instance.pid;
}
process.on("message", message => {
  if (message === "replace") {
    void instance.stop().catch(error => process.send?.({ error: String(error) }));
    process.send?.({ nextCore: startGit() });
  }
  if (message === "request") {
    void instance.call("core.echo", { value: "late" }).then(
      () => process.send?.({ lateCode: "ok" }),
      error => process.send?.({ lateCode: error.code ?? "error" })
    );
    process.send?.({ afterShutdown: instance.pid });
  }
  if (message === "finish") globalThis.__shellTestExit(1);
});
process.stdin.once("end", () => process.send?.({ stdinCore: instance.pid }));
process.stdin.resume();
process.send?.({ core: startGit() });`,
			);
			const built = await build({
				configFile: false,
				logLevel: "silent",
				build: {
					target: "esnext",
					ssr: fixture,
					write: false,
					minify: false,
					rollupOptions: { output: { format: "es", inlineDynamicImports: true } },
				},
			});
			const outputs = Array.isArray(built) ? built : [built];
			const chunk = outputs
				.flatMap(output => ("output" in output ? output.output : []))
				.find(output => output.type === "chunk");
			if (!chunk || chunk.type !== "chunk") throw new Error("main fixture was not bundled");
			// Hold the real Node exit at the boundary so the test can inspect both process groups and issue a late call.
			const prelude = `const __dirname = ${JSON.stringify(mainDir)};
globalThis.__shellTestExit = process.exit.bind(process);
process.exit = code => process.send?.({ exitRequested: code ?? 0 });
`;
			node = spawn(process.execPath, ["--input-type=module", "--eval", `${prelude}${chunk.code}`], {
				stdio: ["pipe", "ignore", "pipe", "ipc"],
				env: { ...process.env, OMPDESK_SHELL_SOCKET: socketPath, OMPDESK_SHELL_TOKEN: randomUUID() },
			});
			let stderr = "";
			node.stderr?.on("data", (part: Buffer) => {
				stderr += part.toString();
			});
			const ended = Promise.withResolvers<number | null>();
			node.once("exit", ended.resolve);
			const exited = ended.promise;
			const streamsClosed = Promise.withResolvers<void>();
			node.once("close", () => streamsClosed.resolve());
			node.on("message", (message: unknown) => {
				if (typeof message !== "object" || message === null) return;
				if ("core" in message && typeof message.core === "number") coreReady.resolve(message.core);
				if ("nextCore" in message && typeof message.nextCore === "number") nextCoreReady.resolve(message.nextCore);
				if ("error" in message) failed.reject(new Error(String(message.error)));
				if ("exitRequested" in message && typeof message.exitRequested === "number")
					exitRequested.resolve(message.exitRequested);
				if ("stdinCore" in message && (typeof message.stdinCore === "number" || message.stdinCore === null))
					stdinEnded.resolve(message.stdinCore);
				if ("afterShutdown" in message && (typeof message.afterShutdown === "number" || message.afterShutdown === null))
					restartAttempt.resolve(message.afterShutdown);
				if ("lateCode" in message && typeof message.lateCode === "string") lateAnswer.resolve(message.lateCode);
			});
			const beforeExit = <T>(promise: Promise<T>): Promise<T> =>
				Promise.race([
					promise,
					failed.promise,
					exited.then(code => {
						throw new Error(`main exited ${String(code)} before the test finished: ${stderr}`);
					}),
				]);
			shell = await beforeExit(shellReady.promise);
			firstCore = await beforeExit(coreReady.promise);
			const firstGit = await beforeExit(firstGitReady.promise);
			if (!Number.isSafeInteger(firstCore) || firstCore <= 0) throw new Error("invalid first core pid");
			let secondGit = firstGit;
			if (process.platform !== "win32") {
				process.kill(firstCore, "SIGSTOP");
				node.send?.("replace", () => {});
				secondCore = await beforeExit(nextCoreReady.promise);
				secondGit = await beforeExit(secondGitReady.promise);
				expect(secondCore).not.toBe(firstCore);
			}
			expect(() => process.kill(firstGit.pid, 0)).not.toThrow();
			expect(() => process.kill(secondGit.pid, 0)).not.toThrow();

			if (shutdown !== "stdin") shell.close();
			if (shutdown !== "socket") {
				if (!node.stdin) throw new Error("main has no stdin pipe");
				node.stdin.end();
				expect(await beforeExit(stdinEnded.promise)).toBeNull();
			}
			expect(await beforeExit(exitRequested.promise)).toBe(1);
			const exitedAt = Date.now();
			expect(await ompRuns(firstGit.pid, exitedAt)).toBe(false);
			expect(await ompRuns(secondGit.pid, exitedAt)).toBe(false);
			await Promise.all([firstGit.closed, secondGit.closed]);
			expect(secondGit.term).toBe(false);

			node.send?.("request", () => {});
			const restarted = await beforeExit(restartAttempt.promise);
			if (restarted !== null) extraCore = restarted;
			expect(restarted).toBeNull();
			expect(await beforeExit(lateAnswer.promise)).toBe("core_unavailable");
			node.send?.("finish", () => {});
			expect(await exited).toBe(1);
			await streamsClosed.promise;
			expect(stderr.match(/\[shell-host\] .*; exiting/g)).toHaveLength(1);
			expect(stderr).not.toContain("core shutdown failed");
			completed = true;
		} finally {
			shell?.close();
			for (const socket of sockets) socket.destroy();
			if (node?.exitCode === null && node.signalCode === null) node.kill("SIGKILL");
			if (!completed) {
				for (const pid of [firstCore, secondCore, extraCore]) {
					if (pid === undefined) continue;
					try {
						process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
					} catch {
						// The captured process group is already gone.
					}
				}
			}
			await Promise.all([close(shellServer), close(gitServer)]);
			await rm(dir, RM_TEMP);
		}
	},
	30_000,
);
