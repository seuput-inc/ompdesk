import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { build } from "vite";
import { expect, it } from "vitest";
import { DIES_WITH_TEST, RM_TEMP } from "../../test-fake-omp";
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

it.skipIf(process.platform === "win32").each(["socket", "stdin", "both"] as const)(
	"keeps main alive after shell %s closes until its core's running git exits",
	async shutdown => {
		const dir = await mkdtemp(join(tmpdir(), "omp-shell-life-"));
		const socketPath = join(dir, "host.sock");
		const shellReady = Promise.withResolvers<ShellClient>();
		const gitReady = Promise.withResolvers<{ socket: Socket; pid: number }>();
		const gitStopping = Promise.withResolvers<void>();
		const coreReady = Promise.withResolvers<number>();
		const stdinEnded = Promise.withResolvers<number | null>();
		const restartAttempt = Promise.withResolvers<number | null>();
		let shell: ShellClient | undefined;
		let gitSocket: Socket | undefined;
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
			gitSocket = socket;
			createInterface({ input: socket }).on("line", line => {
				if (line.startsWith("ready:")) gitReady.resolve({ socket, pid: Number(line.slice(6)) });
				if (line === "stopping") gitStopping.resolve();
			});
		});
		let node: ChildProcess | undefined;
		let git: { socket: Socket; pid: number } | undefined;
		let corePid: number | undefined;
		let extraCorePid: number | undefined;
		let completed = false;
		try {
			await Promise.all([listen(shellServer, socketPath), listen(gitServer, 0)]);
			const gitAddress = gitServer.address();
			if (!gitAddress || typeof gitAddress === "string") throw new Error("git fixture has no TCP port");
			const gitScript = `${DIES_WITH_TEST}
const socket = require("node:net").connect(${gitAddress.port}, "127.0.0.1", () => socket.write("ready:" + process.pid + "\\n"));
process.on("SIGTERM", () => socket.write("stopping\\n"));
socket.on("data", () => process.exit(0));`;
			const mainDir = join(__dirname, "..", "..");
			const fixture = join(dir, "main.ts");
			await writeFile(
				fixture,
				`import { core } from ${JSON.stringify(join(mainDir, "core", "process.ts"))};
import ${JSON.stringify(join(__dirname, "index.ts"))};
const instance = core();
process.on("message", message => {
  if (message === "ping") process.send?.("pong");
  if (message === "request") {
    void instance.call("core.echo", { value: "late" }).catch(() => {});
    process.send?.({ afterShutdown: instance.pid });
  }
});
void instance.call("git.stage", {
  root: ${JSON.stringify(dir)}, paths: null,
  git: { bin: process.execPath, args: ["-e", ${JSON.stringify(gitScript)}], env: process.env, timeoutMs: 600000, maxBytes: 1024 }
}).catch(error => process.send?.({ error: String(error) }));
process.stdin.once("end", () => process.send?.({ stdinCore: instance.pid }));
process.stdin.resume();
process.send?.({ core: instance.pid });`,
			);
			const built = await build({
				configFile: false,
				logLevel: "silent",
				build: {
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
			node = spawn(
				process.execPath,
				["--input-type=module", "--eval", `const __dirname = ${JSON.stringify(mainDir)};\n${chunk.code}`],
				{
					stdio: ["pipe", "ignore", "pipe", "ipc"],
					env: { ...process.env, OMPDESK_SHELL_SOCKET: socketPath, OMPDESK_SHELL_TOKEN: randomUUID() },
				},
			);
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
				if (typeof message === "object" && message !== null && "core" in message && typeof message.core === "number")
					coreReady.resolve(message.core);
				if (typeof message === "object" && message !== null && "error" in message)
					gitReady.reject(new Error(String(message.error)));
				if (
					typeof message === "object" &&
					message !== null &&
					"stdinCore" in message &&
					(typeof message.stdinCore === "number" || message.stdinCore === null)
				)
					stdinEnded.resolve(message.stdinCore);
				if (
					typeof message === "object" &&
					message !== null &&
					"afterShutdown" in message &&
					(typeof message.afterShutdown === "number" || message.afterShutdown === null)
				)
					restartAttempt.resolve(message.afterShutdown);
			});
			const beforeExit = <T>(promise: Promise<T>): Promise<T> =>
				Promise.race([
					promise,
					exited.then(code => {
						throw new Error(`main exited ${String(code)} before setup: ${stderr}`);
					}),
				]);
			shell = await beforeExit(shellReady.promise);
			corePid = await beforeExit(coreReady.promise);
			git = await beforeExit(gitReady.promise);
			if (shutdown !== "stdin") shell.close();
			if (shutdown !== "socket") {
				if (!node.stdin) throw new Error("main has no stdin pipe");
				node.stdin.end();
				expect(await beforeExit(stdinEnded.promise)).toBeNull();
			}
			const first = await Promise.race([gitStopping.promise.then(() => "stopping"), exited.then(() => "exited")]);
			if (first === "stopping") {
				const pong = Promise.withResolvers<void>();
				node.on("message", message => {
					if (message === "pong") pong.resolve();
				});
				node.send?.("ping", () => {});
				const alive = await Promise.race([pong.promise.then(() => true), exited.then(() => false)]);
				node.send?.("request", () => {});
				const restarted = await beforeExit(restartAttempt.promise);
				if (restarted !== null) extraCorePid = restarted;
				git.socket.write("release\n");
				expect(alive).toBe(true);
				expect(restarted).toBeNull();
			}
			expect(first).toBe("stopping");
			expect(await exited).toBe(1);
			await streamsClosed.promise;
			expect(stderr.match(/\[shell-host\] .*; exiting/g)).toHaveLength(1);
			const gitPid = git.pid;
			expect(() => process.kill(gitPid, 0)).toThrow();
			completed = true;
		} finally {
			shell?.close();
			gitSocket?.destroy();
			if (node?.exitCode === null && node.signalCode === null) node.kill("SIGKILL");
			if (!completed && corePid !== undefined) {
				try {
					process.kill(-corePid, "SIGKILL");
				} catch {
					// The process group is already gone.
				}
			}
			if (!completed && extraCorePid !== undefined) {
				try {
					process.kill(-extraCorePid, "SIGKILL");
				} catch {
					// The process group is already gone.
				}
			}
			await Promise.all([close(shellServer), close(gitServer)]);
			await rm(dir, RM_TEMP);
		}
	},
	30_000,
);
