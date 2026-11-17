/**
 * A core that ends under running tabs takes their omps with it (the Mac mini, 17 Nov 2026: the core went at 05:59Z
 * while main ran on, and no tab's omp came back until the app was relaunched at 06:13). Each tab must open its lane
 * in the next core and start a new omp on the session it was on, as the app's tabs start: through the app's start
 * queue and the wait for the session's owner.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SidecarStatus } from "../shared/rpc-types";
import { core } from "./core/process";
import type { OmpResolution } from "./omp-runtime";
import { SidecarManager } from "./sidecar";
import { ANSWERS_COMMANDS, RM_TEMP, writeFakeOmp } from "./test-fake-omp";

const TABS = 4;

function ompAt(bin: string): () => Promise<OmpResolution> {
	return async () => ({
		ok: true,
		runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
	});
}

/** Resolves at the tab's next `ready`. */
function nextReady(sidecar: SidecarManager): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const onStatus = ({ status }: { status: SidecarStatus }) => {
		if (status !== "ready") return;
		sidecar.off("status", onStatus);
		resolve();
	};
	sidecar.on("status", onStatus);
	return promise;
}

describe("tabs whose core ended under them", () => {
	it("each start a new omp on its own session in the next core", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-core-loss-"));
		const spawns = path.join(tempDir, "spawns.log");
		const binaryPath = await writeFakeOmp(
			tempDir,
			`import * as fs from "node:fs";\nfs.appendFileSync(${JSON.stringify(spawns)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\n${ANSWERS_COMMANDS}\n`,
		);
		const sessions = Array.from({ length: TABS }, (_, index) => path.join(tempDir, `s${index}.jsonl`));
		for (const session of sessions) await fs.writeFile(session, "{}\n");
		const reports: Array<{ step: string; session: unknown }> = [];
		const sidecars = sessions.map(
			() =>
				new SidecarManager({
					omp: ompAt(binaryPath),
					cwd: tempDir,
					// As the app's tabs: through the app's start queue, and after the session's owner let go.
					startQueue: {},
					sessionFree: async () => "free",
					reportRecovery: (step, details) => reports.push({ step, session: details.session }),
				}),
		);
		const lossReports: Array<{ step: string; details: Record<string, unknown> }> = [];
		core().report = (step, details) => lossReports.push({ step, details });
		try {
			await Promise.all(
				sidecars.map((sidecar, index) => {
					const ready = nextReady(sidecar);
					sidecar.restart(undefined, sessions[index]);
					return ready;
				}),
			);
			const before = (await fs.readFile(spawns, "utf8")).trim().split("\n");
			expect(before).toHaveLength(TABS);
			// A start that is no recovery reports nothing.
			expect(reports).toEqual([]);

			const back = sidecars.map(nextReady);
			// As a hub call past its deadline ends it: every lane and every omp of that core is gone.
			core().abandon("a test ends the core");
			await Promise.all(back);

			const after = (await fs.readFile(spawns, "utf8")).trim().split("\n").slice(TABS);
			expect(after.map(line => JSON.parse(line) as string[]).sort()).toEqual(
				sessions.map(session => ["--mode", "rpc-ui", "--session", session]).sort(),
			);
			for (const sidecar of sidecars) {
				expect(sidecar.status).toBe("ready");
				expect(sidecar.processAlive).toBe(true);
			}
			// Each tab's way back, step by step, named by its session file.
			for (const session of sessions)
				expect(
					reports.filter(report => report.session === path.basename(session)).map(report => report.step),
				).toEqual(["lane-lost", "resolved", "launch", "spawned"]);
			expect(reports).toHaveLength(TABS * 4);
			await vi.waitFor(() => expect(lossReports.map(report => report.step)).toEqual(["abandoned", "ended"]));
			expect(lossReports[0]?.details).toMatchObject({ reason: "a test ends the core" });
			expect(lossReports[1]?.details).toMatchObject({ abandoned: true, answered: true });
		} finally {
			core().report = null;
			for (const sidecar of sidecars) sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 60_000);

	it("names what a recovering start still waits on when it does not come back", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-core-loss-slow-"));
		const binaryPath = await writeFakeOmp(
			tempDir,
			`process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\n${ANSWERS_COMMANDS}\n`,
		);
		let hang = false;
		const reports: Array<{ step: string; details: Record<string, unknown> }> = [];
		const sidecar = new SidecarManager({
			omp: ompAt(binaryPath),
			cwd: tempDir,
			// After the loss, one of the start's inputs never settles.
			builtinMcp: () => (hang ? Promise.withResolvers<{ args: string[] }>().promise : Promise.resolve({ args: [] })),
			recoverySlowMs: 200,
			reportRecovery: (step, details) => reports.push({ step, details }),
		});
		try {
			const ready = nextReady(sidecar);
			sidecar.start();
			await ready;
			hang = true;
			core().abandon("a test ends the core");
			await vi.waitFor(() => expect(reports.map(report => report.step)).toEqual(["lane-lost", "resolve-slow"]), {
				timeout: 10_000,
			});
			expect(reports[1]?.details).toMatchObject({ pending: "builtinMcp" });
			expect(sidecar.status).not.toBe("ready");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 30_000);
});
