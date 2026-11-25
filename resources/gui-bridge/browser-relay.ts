/**
 * Agent browsing in OMPdesk's preview (Preview panel › "Let the agent use this
 * page"). Stock's relay serves CDP on loopback; the session's
 * browser.relay and browser.relayUrl are held as runtime
 * overrides (never written to config.yml), so stock's browser tool resolves to
 * relay mode and drives whatever tab the relay's extension offers. OMPdesk's
 * main process connects as that extension (src/main/preview/agent-relay.ts) and
 * offers only the visible preview page.
 *
 * The extension socket needs the random token this method returns; the server
 * binds 127.0.0.1 only and refuses browser Origins on its CDP socket.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { guard } from "./health";
import { previewRelayStarted, previewRelayStopped } from "./modes/default-browser";
import { attach } from "./modes/shared";
import { type RelayServer, startRelayServer } from "./omp/pi-coding-agent/tools/browser/relay/server";
import { overridable } from "./settings-override";
import type { BridgeMethods } from "./types";

interface RunningRelay {
	server: RelayServer;
	url: string;
	extension: Bun.Server<undefined>;
	token: string;
	scope: object;
}

let running: RunningRelay | null = null;

/** Stock's native-host mode has no token option. Admit Preview to its in-process bridge, not stock's /ext. */
function listenForPreview(server: RelayServer, token: string) {
	return Bun.serve<undefined>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, listener) {
			const url = new URL(request.url);
			if (url.pathname !== "/ext") return new Response(null, { status: 404 });
			if (request.headers.has("origin")) return new Response(null, { status: 403 });
			if (url.searchParams.get("token") !== token) return new Response(null, { status: 401 });
			if (!listener.upgrade(request)) return new Response(null, { status: 426 });
		},
		websocket: {
			idleTimeout: 0,
			maxPayloadLength: 256 * 1024 * 1024,
			open: socket => server.bridge.extConnected(socket),
			message: (socket, message) => server.bridge.extMessage(socket, message.toString()),
			close: socket => server.bridge.extClosed(socket),
		},
	});
}

function stop(): void {
	if (!running) return;
	const { server, extension, scope } = running;
	running = null;
	void extension.stop(true);
	server.stop();
	overridable("browser.relay").clearOverride(scope);
	overridable("browser.relayUrl").clearOverride(scope);
	previewRelayStopped(scope);
}

export const methods: BridgeMethods = guard("agentBrowser", {
	/** Start (or reuse) this session's relay and point its browser tool at it. */
	"browser.relay_start": async (_params, env) => {
		const scope = attach(env).settings as unknown as object;
		if (running && running.scope !== scope) stop();
		if (!running) {
			const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
			const server = startRelayServer({ port: 0, chatOnly: true, group: false });
			try {
				const extension = listenForPreview(server, token);
				running = { server, extension, url: `http://127.0.0.1:${server.port}`, token, scope };
			} catch (error) {
				server.stop();
				throw error;
			}
		}
		previewRelayStarted(scope);
		overridable("browser.relay").override(scope, true);
		overridable("browser.relayUrl").override(scope, running.url);
		return {
			url: running.url,
			extensionUrl: `http://127.0.0.1:${running.extension.port}`,
			token: running.token,
		};
	},
	/** Stop the relay and give the browser tool back its configured browser. */
	"browser.relay_stop": async () => {
		stop();
		return {};
	},
});

/** The relay dies with the session it serves. */
export function install(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => stop());
}
