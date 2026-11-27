/**
 * The channel policy against what really crosses: the handlers main registers (`ipc.handle` / `ipc.on`
 * in src/main, read from the source) and the push channels `createOmpApi` subscribes to.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import * as botConnectors from "../../shared/bot-connector-channels";
import * as bots from "../../shared/bots";
import * as bridgeHealth from "../../shared/bridge-health";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import * as mailAccounts from "../../shared/mail-accounts";
import * as mobileWeb from "../../shared/mobile-web";
import { createOmpApi } from "../../shared/omp-api";
import * as preview from "../../shared/preview";
import * as schedules from "../../shared/schedule-channels";
import * as sidebarProjects from "../../shared/sidebar-projects";
import * as sshTools from "../../shared/ssh-tools";
import * as trackers from "../../shared/tracker-channels";
import { IPC_POLICY, type IpcChannel } from "./ipc-policy";

const MAIN = path.join(__dirname, "..");
/** The channels the Tauri shell serves itself (`ipc_router.rs`): main registers no handler for them. */
const NATIVE = JSON.parse(
	fs.readFileSync(path.join(MAIN, "../../native/ompdesk/crates/tauri-shell/src/ipc_router.json"), "utf8"),
) as { invoke: string[]; send: string[] };
const NAMED: Record<string, unknown> = {
	...botConnectors,
	...bots,
	...bridgeHealth,
	...mailAccounts,
	...mobileWeb,
	...preview,
	...schedules,
	...sidebarProjects,
	...sshTools,
	...trackers,
};
const GROUPS: Record<string, Record<string, string>> = { IPC_COMMANDS, IPC_EVENTS };

/** The channel a registration's first argument names: `IPC_COMMANDS.X`, a shared constant, or a literal. */
function channelOf(expression: string): string {
	const literal = /^"([^"]+)"$/.exec(expression);
	if (literal?.[1]) return literal[1];
	const [group, key] = expression.split(".");
	const value = key && group ? GROUPS[group]?.[key] : NAMED[expression];
	if (typeof value !== "string") throw new Error(`Unresolved channel expression: ${expression}`);
	return value;
}

/** Every `ipc.handle(…)` / `ipc.on(…)` channel in main's sources, by direction. */
function registeredChannels(): { invoke: string[]; send: string[] } {
	const invoke: string[] = [];
	const send: string[] = [];
	const files = fs.readdirSync(MAIN, { recursive: true, encoding: "utf8" });
	for (const file of files) {
		if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.endsWith("ipc-registry.ts")) continue;
		const source = fs.readFileSync(path.join(MAIN, file), "utf8");
		for (const match of source.matchAll(/\bipc\.(handle|on)\(\s*([^,\s]+)\s*,/g)) {
			const [, method, expression] = match;
			if (!expression) continue;
			(method === "handle" ? invoke : send).push(channelOf(expression));
		}
	}
	return { invoke: invoke.sort(), send: send.sort() };
}

function policyChannels(dir: "invoke" | "send" | "push"): string[] {
	return Object.entries(IPC_POLICY)
		.filter(([, policy]) => policy.dir === dir)
		.map(([channel]) => channel)
		.sort();
}

/** The push channels the renderer API subscribes to: every `on…` function, called once. */
function subscribedChannels(): string[] {
	const channels: string[] = [];
	const api = createOmpApi({
		invoke: async () => undefined as never,
		send: () => {},
		on: channel => {
			channels.push(channel);
			return () => {};
		},
	});
	const visit = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return;
		for (const [name, value] of Object.entries(node)) {
			if (typeof value === "function" && /^on[A-Z]/.test(name)) value(() => {});
			else visit(value);
		}
	};
	visit(api);
	return [...new Set(channels)].sort();
}

describe("IPC channel policy", () => {
	it("gives every invoke and send channel exactly one owner: main, the shell or the core's router", () => {
		const { invoke, send } = registeredChannels();
		const native = [...NATIVE.invoke, ...NATIVE.send];
		// Channels the core's router answers for a page itself (`mode: "core"`): main registers no handler for them.
		const coreServed = Object.entries(IPC_POLICY)
			.filter(([, policy]) => policy.mode === "core")
			.map(([channel, policy]) => ({ channel, dir: policy.dir }));
		const core = coreServed.map(({ channel }) => channel);
		expect(new Set(invoke).size).toBe(invoke.length);
		expect(new Set(send).size).toBe(send.length);
		expect(new Set(native).size).toBe(native.length);
		expect([...invoke, ...send].filter(channel => native.includes(channel))).toEqual([]);
		expect([...invoke, ...send, ...native].filter(channel => core.includes(channel))).toEqual([]);
		const coreOf = (dir: string) => coreServed.filter(entry => entry.dir === dir).map(({ channel }) => channel);
		expect([...invoke, ...NATIVE.invoke, ...coreOf("invoke")].sort()).toEqual(policyChannels("invoke"));
		expect([...send, ...NATIVE.send, ...coreOf("send")].sort()).toEqual(policyChannels("send"));
		// The remaining-work meter of docs/rust-node-removal.md: the page channels main still serves.
		const remaining = [...invoke, ...send].sort();
		console.info(
			`[ipc] main serves ${remaining.length} page channels, the shell ${native.length}: ${remaining.join(" ")}`,
		);
	});

	it("classifies exactly the push channels the renderer API listens to", () => {
		expect(subscribedChannels()).toEqual(policyChannels("push"));
	});

	it("refuses only the pairing boundary, and grants pairing-admin nowhere else", () => {
		const boundary = Object.entries(IPC_POLICY).filter(([, policy]) => policy.mode === "boundary");
		const expected = [...mobileWeb.MOBILE_WEB_ADMIN_CHANNELS].sort();
		expect(boundary.map(([channel]) => channel).sort()).toEqual(expected);
		const pairing = Object.entries(IPC_POLICY).filter(
			([, policy]) => policy.dir !== "push" && policy.permission === "pairing-admin",
		);
		expect(pairing.map(([channel]) => channel).sort()).toEqual(expected);
	});

	it("says what the web side does for every channel it does not pass through", () => {
		for (const [channel, policy] of Object.entries(IPC_POLICY) as [IpcChannel, (typeof IPC_POLICY)[IpcChannel]][]) {
			if (policy.mode === "pass" || policy.mode === "boundary" || policy.mode === "core") continue;
			expect(policy.web.trim(), channel).not.toBe("");
		}
	});
});
