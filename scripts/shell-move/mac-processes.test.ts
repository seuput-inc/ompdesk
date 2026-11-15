import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

const modulePath = join(__dirname, "mac-processes.sh");

const childScript = `
process.on('SIGTERM', () => console.log('term'));
process.stdin.once('data', () => process.exit(0));
console.log('ready');
`;

const consumerScript = `
. "$1"
evidence() { echo "$*"; }
if [ "$4" = controlled ] || [ "$4" = graceful ]; then
  sleep() { echo waiting; read -r release; }
else
  sleep() { :; }
fi
if [ "$4" = graceful ]; then action=wait_app; else action=stop_app; fi
if "$action" "$2" "$3"; then
  rm "$5"
  echo launched > "$6"
else
  exit 1
fi
`;

describe.skipIf(process.platform === "win32")("macOS move process stop", () => {
	for (const mode of ["controlled", "stubborn", "graceful"] as const) {
		it(
			mode === "graceful"
				? "observes a normal quit without signalling the owned process"
				: mode === "controlled"
					? "waits for the owned process before cleanup and launch"
					: "refuses to continue while the owned process remains alive",
			async () => {
				const dir = await mkdtemp(join(tmpdir(), "mac-stop-"));
				const log = join(dir, "seed.log");
				const launch = join(dir, "launch");
				await writeFile(log, "seed evidence");
				const child = spawn(process.execPath, ["-e", childScript], { stdio: ["pipe", "pipe", "ignore"] });
				const childExit = once(child, "close");
				const childLines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
				let consumer: ChildProcess | undefined;
				let consumerExit: Promise<unknown[]> | undefined;
				try {
					expect((await childLines.next()).value).toBe("ready");
					consumer = spawn(
						"bash",
						[
							"-c",
							consumerScript,
							"bash",
							modulePath,
							join(dir, "fixture.app"),
							String(child.pid),
							mode,
							log,
							launch,
						],
						{ stdio: ["pipe", "pipe", "ignore"] },
					);
					consumerExit = once(consumer, "close");
					const lines = createInterface({ input: consumer.stdout! })[Symbol.asyncIterator]();
					if (mode !== "stubborn") {
						if (mode === "controlled") expect((await childLines.next()).value).toBe("term");
						expect((await lines.next()).value).toBe("waiting");
						expect(await readFile(log, "utf8")).toBe("seed evidence");
						await expect(readFile(launch)).rejects.toMatchObject({ code: "ENOENT" });
						child.stdin.write("exit\n");
						await childExit;
						if (mode === "graceful") expect((await childLines.next()).done).toBe(true);
						consumer.stdin!.write("continue\n");
						expect((await consumerExit)[0]).toBe(0);
						await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
						expect(await readFile(launch, "utf8")).toBe("launched\n");
					} else {
						expect((await consumerExit)[0]).toBe(1);
						expect(child.exitCode).toBeNull();
						expect(await readFile(log, "utf8")).toBe("seed evidence");
						await expect(readFile(launch)).rejects.toMatchObject({ code: "ENOENT" });
					}
				} finally {
					consumer?.kill("SIGKILL");
					child.kill("SIGKILL");
					if (consumerExit) await consumerExit;
					await childExit;
					await rm(dir, { recursive: true, force: true });
				}
			},
		);
	}
});
