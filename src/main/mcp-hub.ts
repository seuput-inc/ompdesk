import { MCP_AUTH_ENV, MCP_HUB_ENV } from "../../resources/gui-bridge/mcp-hub-contracts";
import { CORE_EXITED, CoreError, type CoreProcess, core } from "./core/process";

interface Binding {
	port: number;
	secret: string;
}

type OmpEnv = Record<typeof MCP_HUB_ENV | typeof MCP_AUTH_ENV, string>;
type NoEnv = Record<string, never>;

type Notice =
	| { message: "listening"; details: { port: number; pid: number } }
	| { message: "exited"; details: { reason: string; restartInMs: number | null } };

interface McpHubLaunch {
	memoryStateFile: string;
	log?: (notice: Notice) => void;
}

/** The core owns the child. A running omp's environment outlives a core generation, so main keeps its binding in memory. */
export class McpHub {
	readonly #launch: McpHubLaunch;
	readonly #client: CoreProcess;
	readonly #unsubscribe: () => void;
	#binding: Binding | null = null;
	#generation?: number;
	#stops = 0;
	#stopping?: Promise<void>;

	constructor(launch: McpHubLaunch, client = core()) {
		this.#launch = launch;
		this.#client = client;
		const offLog = client.on("mcpHub.log", (data, _bin, generation) => {
			if (generation === this.#generation) launch.log?.(data as Notice);
		});
		const offReady = client.on("ready", (_data, _bin, generation) => {
			if (this.#generation !== undefined && generation === client.generation && generation !== this.#generation) {
				void this.ompEnv();
			}
		});
		const offExit = client.on(CORE_EXITED, (_data, _bin, generation) => {
			// An already running omp must reconnect without waiting for a new tab. Respect an intentional core stop.
			if (
				generation === this.#generation &&
				client.generation === 0 &&
				client.stops === this.#stops &&
				!client.shuttingDown
			) {
				void this.ompEnv();
			}
		});
		this.#unsubscribe = () => {
			offLog();
			offReady();
			offExit();
		};
	}

	async ompEnv(): Promise<OmpEnv | NoEnv> {
		if (this.#stopping) return {};
		// Cancelling the ready wait does not cancel the app's hub. An omp starts without it after ten seconds.
		const waiting = this.#client.call<Binding | null>(
			"mcpHub.env",
			{ memoryStateFile: this.#launch.memoryStateFile, binding: this.#binding },
			{ timeoutMs: 10_000 },
		);
		this.#generation = this.#client.generation;
		this.#stops = this.#client.stops;
		const received = waiting.then(
			({ result, generation }) => {
				if (!this.#stopping && generation === this.#client.generation) this.#binding ??= result;
			},
			(error: unknown) => {
				if (!this.#stopping) console.warn("[mcp-hub] unavailable", error instanceof CoreError ? error.code : "");
			},
		);
		if (!this.#binding) await received;
		return this.#binding
			? { [MCP_HUB_ENV]: `http://127.0.0.1:${this.#binding.port}`, [MCP_AUTH_ENV]: `Bearer ${this.#binding.secret}` }
			: {};
	}

	kill(): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#unsubscribe();
		this.#binding = null;
		const generation = this.#generation;
		this.#stopping =
			generation && generation === this.#client.generation
				? this.#client.call<null>("mcpHub.stop", {}, { generation }).then(() => undefined)
				: Promise.resolve();
		return this.#stopping;
	}
}
