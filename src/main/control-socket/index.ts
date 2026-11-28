/**
 * Starts the core's local control socket. A failed start is one log line, a null handle, the reason kept for
 * Settings (`controlSocketFailure`) and written to `start-failure.txt` in the control folder, which the `ompdesk`
 * command prints with its "not running" exit 3; a start that succeeds removes the file.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONTROL_PROTOCOL_VERSION, START_FAILURE_FILE } from "../../shared/control-protocol";
import { core } from "../core/process";
import type { ControlBackend } from "./backend";
import { controlEndpoint, prepareControlDir, readOrCreateToken } from "./endpoint";
import { setControlEndpoint } from "./env";
import { ControlServer, type ControlTuning } from "./server";

export interface ControlSocketOptions {
	userData: string;
	backend: ControlBackend;
	platform?: NodeJS.Platform;
	log?: (line: string) => void;
	/** Shorter beats and limits for parity tests against the real core. */
	tuning?: ControlTuning;
}

export interface ControlSocketHandle {
	socket: string;
	dir: string;
	close(): Promise<void>;
}

let failure: string | null = null;
let failureSyncRegistered = false;

function syncFailure(): void {
	if (!failureSyncRegistered) {
		failureSyncRegistered = true;
		core().on("ready", () => {
			void core()
				.call("control.setFailure", { failure })
				.catch(() => {});
		});
	}
	void core()
		.call("control.setFailure", { failure })
		.catch(() => {});
}

/** Why this launch's control socket did not start, or null. */
export function controlSocketFailure(): string | null {
	return failure;
}

export async function startControlSocket({
	userData,
	backend,
	platform = process.platform,
	log = () => undefined,
	tuning,
}: ControlSocketOptions): Promise<ControlSocketHandle | null> {
	const { dir, socket, socketDir } = controlEndpoint(userData, platform);
	// Known before the first await: a session spawned while the socket comes up can still find it.
	setControlEndpoint({ socket, dir });
	let server: ControlServer | undefined;
	try {
		const exposed = await prepareControlDir(dir);
		if (socketDir) await prepareControlDir(socketDir);
		const token = await readOrCreateToken(dir, { exposed });
		server = new ControlServer({
			token,
			backend,
			tuning,
			log,
			publish: { dir, endpoint: { version: CONTROL_PROTOCOL_VERSION, socket, pid: process.pid } },
		});
		await server.listen(socket);
	} catch (error) {
		await server?.close();
		setControlEndpoint(null);
		failure = error instanceof Error ? error.message : String(error);
		syncFailure();
		log(`Control socket not started: ${failure}`);
		await mkdir(dir, { recursive: true })
			.then(() => writeFile(join(dir, START_FAILURE_FILE), `${failure}\n`, { mode: 0o600 }))
			.catch(() => undefined);
		return null;
	}
	failure = null;
	syncFailure();
	await rm(join(dir, START_FAILURE_FILE), { force: true }).catch(() => undefined);
	const running = server;
	return {
		socket,
		dir,
		async close() {
			await running.close();
			setControlEndpoint(null);
		},
	};
}
