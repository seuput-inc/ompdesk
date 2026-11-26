/**
 * A host tab's dev server in a paired device's Preview (Orca H105, `host.portTunnel.*` in app-protocol.ts). The server
 * runs on the host's loopback, out of the device's reach, so the device stands in for it on its own loopback and each
 * connection the Preview makes crosses the link as bytes. The sockets are the core's (`remotebytes/ports.rs`: the
 * device's listener with its Host check, the host's dial); which tab, connection and link hold them stays here, because
 * main keeps every link request (native-rust ledger R1-R3).
 * - Host (`HostPortDials`, held by `LocalHostServices`): dials only a port the tab's own processes listen on, checked
 *   on every connection, never an address a device names.
 * - Device (`DevicePortTunnels`, held by `RemoteDevices`): one stand-in per host tab and port, on the host's port number
 *   when it is free here; it ends with the tab, the link, or the app.
 */
import { codedError } from "../../shared/ipc-error-codes";
import { core } from "../core/process";
import { PORT_TUNNEL_METHODS, type PortTunnelEvent } from "./app-protocol";

/** What the core says of a connection: a stand-in took one (`open`), bytes it read, or its end. */
type CoreEvent = { conn: number } & (
	| { kind: "open"; listener: number }
	| { kind: "data"; data: string }
	| { kind: "close" }
);

const connections = new Map<number, (event: CoreEvent) => void>();
const standIns = new Map<number, (conn: number) => void>();
let routed = false;

function route(): void {
	if (routed) return;
	routed = true;
	core().on("remotebytes.port", data => {
		const event = data as CoreEvent;
		if (event.kind === "open") standIns.get(event.listener)?.(event.conn);
		else connections.get(event.conn)?.(event);
	});
}

const unavailable = () => codedError("port_unavailable", "Nothing of this tab listens on that port");

/** Sends one tunnel event to the device that opened the connection; false when it did not go out. */
export type PortPush = (event: PortTunnelEvent) => boolean;

interface Dial {
	owner: object;
	/** The core's number for the host's socket. */
	socket: number;
	open: boolean;
	closed: boolean;
	/** Bytes the device sent while the port was being checked and dialed, in order. */
	queued: string[];
}

let nextDial = 0;

export class HostPortDials {
	readonly #dials = new Map<string, Dial>();

	/**
	 * Connects the device's connection `conn` on tab `key` to `port`, once `owned` says the tab's own processes listen
	 * there. Registers the connection before anything waits, so bytes the device sends meanwhile queue in order.
	 */
	async connect(
		key: string,
		conn: number,
		port: number,
		owner: object,
		push: PortPush,
		owned: () => Promise<boolean>,
	): Promise<void> {
		const id = `${key}\u0000${conn}`;
		this.#end(id);
		route();
		const socket = ++nextDial;
		const dial: Dial = { owner, socket, open: false, closed: false, queued: [] };
		this.#dials.set(id, dial);
		connections.set(socket, event => {
			if (event.kind === "data") {
				if (!push({ kind: "data", conn, data: event.data })) this.#end(id, push, conn);
			} else if (event.kind === "close") {
				connections.delete(socket);
				if (this.#dials.get(id) === dial) this.#dials.delete(id);
				push({ kind: "close", conn });
			}
		});
		try {
			if (!(await owned()) || dial.closed) throw unavailable();
			await core().call("remotebytes.portDial", { conn: socket, port });
		} catch {
			connections.delete(socket);
			if (this.#dials.get(id) === dial) this.#dials.delete(id);
			throw unavailable();
		}
		if (dial.closed) {
			core().push("remotebytes.portClose", { conn: socket });
			throw unavailable();
		}
		dial.open = true;
		for (const data of dial.queued.splice(0)) core().push("remotebytes.portSend", { conn: socket, data });
	}

	/** Bytes (base64) the device's Preview sent on `conn`. */
	send(key: string, conn: number, data: string): void {
		const dial = this.#dials.get(`${key}\u0000${conn}`);
		if (!dial) throw unavailable();
		if (dial.open) core().push("remotebytes.portSend", { conn: dial.socket, data });
		else dial.queued.push(data);
	}

	/** The device's end closed. */
	close(key: string, conn: number): void {
		this.#end(`${key}\u0000${conn}`);
	}

	/** The tab `key` went: every connection to its servers ends. */
	dropTab(key: string): void {
		for (const id of [...this.#dials.keys()]) if (id.startsWith(`${key}\u0000`)) this.#end(id);
	}

	/** A link connection ended: the connections it carried end. */
	dropConnection(owner: object): void {
		for (const [id, dial] of [...this.#dials]) if (dial.owner === owner) this.#end(id);
	}

	dispose(): void {
		for (const id of [...this.#dials.keys()]) this.#end(id);
	}

	#end(id: string, push?: PortPush, conn?: number): void {
		const dial = this.#dials.get(id);
		if (!dial) return;
		this.#dials.delete(id);
		dial.closed = true;
		connections.delete(dial.socket);
		if (dial.open) core().push("remotebytes.portClose", { conn: dial.socket });
		if (push && conn !== undefined) push({ kind: "close", conn });
	}
}

/** What a stand-in needs of the host's link: one request. Failures are the link's own errors. */
export type PortRequester = (method: string, params: unknown) => Promise<unknown>;

interface StandIn {
	deviceId: string;
	rtab: string;
	listener: number;
	/** The loopback port it listens on here. */
	port: number;
	/** Its connections, by the core's number. */
	conns: Set<number>;
}

/** Every loopback port a stand-in listens on here: the Preview lets a paired host's tab show these and no other. */
const standInPorts = new Set<number>();

/** Whether `url` is a stand-in for a paired host tab's server (`DevicePortTunnels`). */
export function tunnelledLoopback(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			parsed.protocol === "http:" &&
			(parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
			standInPorts.has(Number(parsed.port || 80))
		);
	} catch {
		return false;
	}
}

let nextListener = 0;

export class DevicePortTunnels {
	readonly #request: (deviceId: string) => PortRequester | null;
	/** Each host tab's stand-ins, by `deviceId\0rtab\0port`; the promise while the core opens it. */
	readonly #standIns = new Map<string, Promise<StandIn>>();
	/** Each connection's stand-in, so a host's bytes find their socket. */
	readonly #conns = new Map<number, StandIn>();

	constructor(request: (deviceId: string) => PortRequester | null) {
		this.#request = request;
	}

	/** The address here that shows the host tab `rtab`'s server on `port`; opens the stand-in on first use. */
	async open(deviceId: string, rtab: string, port: number): Promise<string> {
		const key = `${deviceId}\u0000${rtab}\u0000${port}`;
		let opening = this.#standIns.get(key);
		if (!opening) {
			opening = this.#listen(deviceId, rtab, port);
			this.#standIns.set(key, opening);
			opening.catch(() => {
				if (this.#standIns.get(key) === opening) this.#standIns.delete(key);
			});
		}
		return `http://localhost:${(await opening).port}/`;
	}

	/** What the host pushed for a connection: the server's bytes, or its end. */
	receive(event: PortTunnelEvent): void {
		if (!this.#conns.has(event.conn)) return;
		if (event.kind === "data") core().push("remotebytes.portSend", { conn: event.conn, data: event.data });
		else this.#endConn(event.conn, false);
	}

	/** The host tab `rtab` closed here: its stand-ins and their connections end. */
	closeTab(deviceId: string, rtab: string): void {
		this.#closeWhere(key => key.startsWith(`${deviceId}\u0000${rtab}\u0000`));
	}

	/** The link to `deviceId` left `online`: the host ends its side with the connection; this side ends too. */
	linkLost(deviceId: string): void {
		this.#closeWhere(key => key.startsWith(`${deviceId}\u0000`));
	}

	dispose(): void {
		this.#closeWhere(() => true);
	}

	async #listen(deviceId: string, rtab: string, port: number): Promise<StandIn> {
		route();
		const listener = ++nextListener;
		const standIn: StandIn = { deviceId, rtab, listener, port: 0, conns: new Set() };
		standIns.set(listener, conn => this.#accepted(standIn, port, conn));
		try {
			const answer = (await core().call<{ port: number }>("remotebytes.portListen", { listener, port })).result;
			standIn.port = answer.port;
		} catch (error) {
			standIns.delete(listener);
			throw error;
		}
		standInPorts.add(standIn.port);
		return standIn;
	}

	/** The Preview opened a connection to the stand-in: the host dials its server, and the bytes go both ways. */
	#accepted(standIn: StandIn, hostPort: number, conn: number): void {
		const request = this.#request(standIn.deviceId);
		if (!request) {
			core().push("remotebytes.portClose", { conn });
			return;
		}
		standIn.conns.add(conn);
		this.#conns.set(conn, standIn);
		const { rtab } = standIn;
		connections.set(conn, event => {
			if (event.kind === "data")
				request(PORT_TUNNEL_METHODS.send, { rtab, conn, data: event.data }).catch(() => this.#endConn(conn, true));
			else if (event.kind === "close") this.#endConn(conn, true, false);
		});
		request(PORT_TUNNEL_METHODS.connect, { rtab, port: hostPort, conn }).catch(() => this.#endConn(conn, false));
	}

	/** Ends `conn` here; `tellHost`: the host's side ends too. `closeHere`: the core's socket is still open. */
	#endConn(conn: number, tellHost: boolean, closeHere = true): void {
		const standIn = this.#conns.get(conn);
		if (!standIn) return;
		this.#conns.delete(conn);
		standIn.conns.delete(conn);
		connections.delete(conn);
		if (closeHere) core().push("remotebytes.portClose", { conn });
		if (tellHost)
			this.#request(standIn.deviceId)?.(PORT_TUNNEL_METHODS.close, { rtab: standIn.rtab, conn }).catch(() => {});
	}

	#closeWhere(matches: (key: string) => boolean): void {
		for (const [key, opening] of [...this.#standIns]) {
			if (!matches(key)) continue;
			this.#standIns.delete(key);
			void opening.then(
				standIn => {
					standIns.delete(standIn.listener);
					standInPorts.delete(standIn.port);
					core().push("remotebytes.portUnlisten", { listener: standIn.listener });
					for (const conn of [...standIn.conns]) this.#endConn(conn, false);
				},
				() => {},
			);
		}
	}
}
