/**
 * How an omp reaches OMPdesk's MCP hub (ompdesk-core --mcp-hub, started by src/main/mcp-hub.ts): main puts these variables into
 * every omp it spawns. Stock expands them when reading the built-in memory entry.
 */

/** `http://127.0.0.1:<port>` of this launch's hub. */
export const MCP_HUB_ENV = "OMP_GUI_MCP_HUB";
/** `Bearer <secret>`: the per-launch secret the hub requires on every request. */
export const MCP_AUTH_ENV = "OMP_GUI_MCP_AUTH";

/** The `ompdesk-memory` entry of memory's extension root (the core's `aimemory/service/root.rs`). */
export const MEMORY_HUB_ENTRY = {
	type: "http",
	url: `\${${MCP_HUB_ENV}}/memory`,
	headers: { Authorization: `\${${MCP_AUTH_ENV}}` },
} as const;
