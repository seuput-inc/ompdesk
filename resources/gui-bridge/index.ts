/**
 * ompdesk's gui-bridge: an omp extension the GUI loads with `-e` so its main process
 * can reach live session state stock RPC does not expose.
 *
 * Transport: the GUI passes a unix socket path (macOS) or named pipe (Windows)
 * in `OMP_GUI_BRIDGE`; this extension listens there. Newline-delimited JSON:
 *   GUI → bridge  `{ id, method, params }`
 *   bridge → GUI  `{ id, ok: true, result }` | `{ id, ok: false, error }`
 *   bridge → GUI  `{ event: { type, … } }` (pushed, see `BridgeEnv.emit`)
 * Without `OMP_GUI_BRIDGE` the extension is inert.
 *
 * Area modules load independently: a module whose static omp import vanished
 * (a link error) takes down only its own features, which `capabilities` and
 * `unsupported_omp` errors then name, instead of the whole extension. They load
 * at the bridge's first use (first connection, first prompt or a subagent's
 * rebind), never while omp starts (see `guiBridge`).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { isMainThread } from "node:worker_threads";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { ALL_FEATURES, type AreaFailure, type FeatureId, mergeAreaFailures, UnsupportedOmpError } from "./capabilities";
import { probe } from "./health";
import { installItemToolFence, ITEM_WORK, ItemToolFence } from "./item-work";
import { A2UI_ENABLED } from "./modes/a2ui-contracts";
import { bindEnv } from "./modes/shared";
import type { RoleSettings } from "./ompdesk-roles";
import type { BridgeEnv, BridgeEvent, BridgeMethods } from "./types";
import { registerWait } from "./waste-guards-wait";

interface Area {
	name: string;
	/** Everything the module serves; unavailable as a whole when it fails to load. */
	features: readonly FeatureId[];
	/** `install`, when exported, registers the module's extension hooks once the module loads. */
	load(): Promise<{ methods: BridgeMethods; install?: (pi: ExtensionAPI) => void }>;
}

// Dynamic on purpose: a static import of an area whose omp export vanished
// fails the whole extension at link time (verified on omp 18.8.0).
const AREAS: readonly Area[] = [
	// First: its `before_agent_start` hook (it waits for the engine's startup check) must run before the sections hook
	// the first `registerPromptSection` caller adds, so a first turn's prompt is built after the check settled.
	{ name: "modes/computer-use", features: ["computerUse"], load: () => import("./modes/computer-use") },
	{
		name: "composer",
		features: [
			"composerState",
			"ultrafast",
			"pythonEval",
			"abortCompaction",
			"bashExcluded",
			"clearContext",
			"forceTool",
			"prewalk",
			"toolExtras",
			"contextReport",
			"jobs",
			"cancelJob",
			"cycleModelBackward",
			"relaunchResume",
			"skillCount",
			"dequeue",
			"share",
			"copyTargets",
			"lastLink",
		],
		load: () => import("./composer"),
	},
	{
		name: "sessions",
		features: ["transcript", "entryIds", "sessionTree", "entryLabel", "switchLeaf", "forkFrom", "sessionPins"],
		load: () => import("./sessions"),
	},
	{
		name: "session-extras",
		features: ["sessionImport", "usageHistory", "localPaste", "localLinks", "argCompletions"],
		load: () => import("./session-extras"),
	},
	{
		name: "workspace",
		features: ["workspace", "resolvePath", "workspaceEdit"],
		load: () => import("./workspace"),
	},
	{
		name: "settings",
		features: [
			"settingsSchema",
			"settings",
			"imageGeneration",
			"models",
			"providers",
			"providerLogout",
			"providerAccounts",
			"usage",
			"modelRoles",
			"modelRoleMetadata",
			"modelRoleSet",
		],
		load: () => import("./settings"),
	},
	{
		name: "model-setup-facts",
		features: ["modelSetupFacts", "sessionSpend"],
		load: () => import("./model-setup-facts"),
	},
	{ name: "ompdesk-roles", features: ["ompdeskRoles"], load: () => import("./ompdesk-roles") },
	{ name: "voice", features: ["dictation", "readAloud"], load: () => import("./voice") },
	{ name: "debug", features: ["debug"], load: () => import("./debug") },
	{
		name: "security",
		features: ["security", "securityScanDetail", "securityRun", "securityDisposition", "securityValidation"],
		load: () => import("./security"),
	},
	{ name: "ssh", features: ["ssh", "sshManage", "sshTest"], load: () => import("./ssh") },
	{ name: "reset-passes", features: ["resetPasses"], load: () => import("./reset-passes") },
	{
		name: "extensions/agents",
		features: [
			"agentValidate",
			"agents",
			"agentDefinition",
			"agentAuthoring",
			"reviveSubagent",
			"subagentTranscript",
			"imageBlob",
			"themes",
		],
		load: () => import("./extensions/agents"),
	},
	{
		name: "extensions/mcp",
		features: [
			"mcp",
			"mcpToggle",
			"mcpReconnect",
			"mcpRemove",
			"mcpAdopt",
			"mcpAdd",
			"mcpTest",
			"mcpReauth",
			"mcpSync",
			"mcpReload",
		],
		load: () => import("./extensions/mcp"),
	},
	{
		name: "extensions/plugins",
		features: [
			"plugins",
			"marketplaces",
			"marketplaceEdit",
			"pluginInstall",
			"pluginToggle",
			"pluginThemes",
			"pluginDetail",
			"pluginFeatures",
			"pluginSettings",
		],
		load: () => import("./extensions/plugins"),
	},
	{
		name: "extensions/skills",
		features: [
			"skills",
			"skillDetail",
			"skillToggle",
			"manageSkill",
			"hooks",
			"hookToggle",
			"contextFiles",
			"contextFileToggle",
			"promptTemplates",
		],
		load: () => import("./extensions/skills"),
	},
	{
		name: "extensions/update",
		features: ["pluginReload", "mcpUpdateReconnect"],
		load: () => import("./extensions/update"),
	},
	{
		name: "modes/goal",
		features: ["guidedGoal", "goalReplace", "goalBudget", "goalTimeLimit"],
		load: () => import("./modes/goal"),
	},
	{ name: "modes/reply-language", features: ["replyLanguage"], load: () => import("./modes/reply-language") },
	{
		name: "modes/next-prompt",
		features: ["nextPrompt", "inlineCompletion"],
		load: () => import("./modes/next-prompt"),
	},
	{ name: "modes/memory-recall", features: ["memoryRecall"], load: () => import("./modes/memory-recall") },
	{ name: "modes/auto-title", features: ["autoTitle"], load: () => import("./modes/auto-title") },
	{ name: "modes/judge-assist", features: ["judgeAssist"], load: () => import("./modes/judge-assist") },
	{ name: "modes/output-style", features: ["outputStyle"], load: () => import("./modes/output-style") },
	{ name: "modes/user-profile", features: ["userProfile"], load: () => import("./modes/user-profile") },
	{ name: "modes/delegation", features: ["delegation"], load: () => import("./modes/delegation") },
	{ name: "modes/visuals", features: ["visuals"], load: () => import("./modes/visuals") },
	{ name: "modes/pstack", features: ["pstack"], load: () => import("./modes/pstack") },
	{ name: "modes/ecc-hint", features: ["eccHint"], load: () => import("./modes/ecc-hint") },
	{ name: "modes/formal-hint", features: ["formalHint"], load: () => import("./modes/formal-hint") },
	{ name: "modes/default-browser", features: ["defaultBrowser"], load: () => import("./modes/default-browser") },
	{
		name: "modes/background-checks",
		features: ["backgroundChecks"],
		load: () => import("./modes/background-checks"),
	},
	{ name: "modes/checkout-peers", features: ["checkoutPeers"], load: () => import("./modes/checkout-peers") },
	{ name: "modes/bots", features: ["bots"], load: () => import("./modes/bots") },
	{ name: "modes/scratch", features: ["scratch"], load: () => import("./modes/scratch") },
	{ name: "modes/check-runs", features: ["checkRuns"], load: () => import("./modes/check-runs") },
	{ name: "modes/a2ui", features: ["a2ui"], load: () => import("./modes/a2ui") },
	{ name: "modes/ci-watch", features: ["ciWatch"], load: () => import("./modes/ci-watch") },
	{ name: "xdev-notice", features: ["xdevNotice", "contextHookIdle"], load: () => import("./xdev-notice") },
	{ name: "account-rotation", features: ["accountRotation"], load: () => import("./account-rotation") },
	{ name: "credit-spend", features: ["creditSpend"], load: () => import("./credit-spend") },
	{ name: "modes/actions", features: ["tan", "omfg", "agentPause"], load: () => import("./modes/actions") },
	{
		name: "compaction-limits",
		features: ["compactionPoints", "compactionLimits"],
		load: () => import("./compaction-limits"),
	},
	{
		name: "idle-maintenance",
		features: ["idleMaintenance", "contextHookIdle"],
		load: () => import("./idle-maintenance"),
	},
	{
		name: "context-inspect",
		features: ["contextInspector", "contextEntry"],
		load: () => import("./context-inspect"),
	},
	{ name: "prompt-origin", features: ["promptOrigin"], load: () => import("./prompt-origin") },
	{ name: "typed-prompts", features: ["typedPrompts"], load: () => import("./typed-prompts") },
	{ name: "answer-first", features: ["answerFirst"], load: () => import("./answer-first") },
	{ name: "recent-models", features: ["recentModels"], load: () => import("./recent-models") },
	{ name: "model-choice", features: ["modelChoice"], load: () => import("./model-choice") },
	{ name: "claude-api-route", features: ["claudeApiRoute"], load: () => import("./claude-api-route") },
	{ name: "input-history", features: ["inputHistory"], load: () => import("./input-history") },
	{
		name: "worktree-lifecycle",
		features: ["worktreeLocation", "prCheckout", "worktreeLifecycle"],
		load: () => import("./worktree-lifecycle"),
	},
	{ name: "stream-metadata", features: ["streamMetadata"], load: () => import("./stream-metadata") },
	{ name: "browser-relay", features: ["agentBrowser"], load: () => import("./browser-relay") },
	{ name: "agent-control", features: ["agentControl"], load: () => import("./agent-control") },
	{ name: "turn-origin", features: ["agentControl"], load: () => import("./turn-origin") },
	{ name: "modes/autopilot", features: ["autopilot"], load: () => import("./modes/autopilot") },
	{ name: "desktop-slot", features: ["desktopSlot"], load: () => import("./desktop-slot") },
	{ name: "session-dump", features: ["sessionDump"], load: () => import("./session-dump") },
	{ name: "advisor-stats", features: ["advisorStats"], load: () => import("./advisor-stats") },
	{ name: "todo-reminder", features: ["todoReminder"], load: () => import("./todo-reminder") },
	{ name: "todo-wait", features: ["todoWait"], load: () => import("./todo-wait") },
	{ name: "todo-stale", features: ["todoStale"], load: () => import("./todo-stale") },
	{ name: "todo-compact", features: ["todoCompact"], load: () => import("./todo-compact") },
	{ name: "todo-drift", features: ["todoDrift"], load: () => import("./todo-drift") },
	{ name: "waste-guards", features: ["wasteGuards"], load: () => import("./waste-guards") },
	{ name: "quit-journal", features: ["quitJournal"], load: () => import("./quit-journal") },
	{ name: "kept-jobs", features: ["keptJobs"], load: () => import("./kept-jobs") },
	{ name: "exit-drain", features: ["exitDrain"], load: () => import("./exit-drain") },
	{ name: "turn-stages", features: ["turnStages"], load: () => import("./turn-stages") },
	{ name: "ask-form", features: ["askForm"], load: () => import("./ask-form") },
	{ name: "image-subscription", features: ["imageSubscription"], load: () => import("./image-subscription") },
];

function builtins(failures: readonly AreaFailure[]): BridgeMethods {
	return {
		/** Startup compatibility self-check: which GUI features this omp cannot serve, and why. */
		capabilities: async (_params, env) => ({
			ompVersion: env.pi.pi.VERSION,
			unavailable: mergeAreaFailures(await probe(env, ALL_FEATURES, { evaluateHeavy: false }), failures),
		}),
	};
}

interface LoadedMethods {
	table: BridgeMethods;
	failures: AreaFailure[];
	/** Each loaded area's `install`, run again on a subagent's `pi` when stock binds the extension anew. */
	installs: Array<(pi: ExtensionAPI) => void>;
}

async function loadMethods(pi: ExtensionAPI): Promise<LoadedMethods> {
	const settled = await Promise.allSettled(AREAS.map(area => area.load()));
	const failures: AreaFailure[] = [];
	const installs: LoadedMethods["installs"] = [];
	const tables: Record<string, BridgeMethods> = {};
	settled.forEach((result, index) => {
		const area = AREAS[index];
		if (result.status === "fulfilled") {
			tables[area.name] = result.value.methods;
			const install = result.value.install;
			if (install) {
				installs.push(install);
				install(pi);
			}
			return;
		}
		const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
		pi.logger.error("gui-bridge: area failed to load", { area: area.name, error });
		failures.push({ area: area.name, features: area.features, error });
	});
	const table: BridgeMethods = {};
	for (const [area, methods] of Object.entries({ builtins: builtins(failures), ...tables })) {
		for (const [name, method] of Object.entries(methods)) {
			if (Object.hasOwn(table, name)) throw new Error(`gui-bridge: method "${name}" is defined twice (${area})`);
			table[name] = method;
		}
	}
	return { table, failures, installs };
}

interface BridgeRequest {
	id: unknown;
	method: unknown;
	params?: unknown;
}

function isRequest(value: unknown): value is BridgeRequest {
	return typeof value === "object" && value !== null && "id" in value && "method" in value;
}

/**
 * The first bind's area installs (undefined when its method table failed). Stock binds every
 * extension again for each in-process subagent (task executor `preloadedPreparedExtensions` →
 * `bindPreparedExtensions` → this factory), in this same module instance and with `OMP_GUI_BRIDGE`
 * still set. The socket server, its table and the spawn-time defaults belong to the process: a
 * rebind that set them up again would unlink main's socket for a server holding the subagent's
 * `pi`, and put the thinking default and the delegation strength back to their spawn-time values
 * over what the user picked since. A rebind only installs each area's hooks on the subagent's `pi`,
 * so its sessions get the prompt sections too.
 *
 * An isolated subagent's run loads the extension through a loader that evaluates the module graph afresh, so a
 * module-level variable would be empty there: the bind lives on `globalThis`, under a shared symbol, and the
 * rebind installs the first graph's hooks (and so shares its ledger).
 */
interface ProcessBind {
	bound?: Promise<LoadedMethods | undefined>;
	fence?: ItemToolFence;
	/** Starts loading the first bind's areas (`bound`) when nothing has yet; later calls do nothing. */
	startLoading?: () => void;
}
const PROCESS_BIND = Symbol.for("ompdesk.gui-bridge");
const holder = globalThis as Record<symbol, unknown>;
holder[PROCESS_BIND] ??= {};
const processBind = holder[PROCESS_BIND] as ProcessBind;

export default async function guiBridge(pi: ExtensionAPI): Promise<void> {
	const address = process.env.OMP_GUI_BRIDGE;
	if (!address) return;
	const descriptor = process.env[ITEM_WORK];
	if (descriptor !== undefined) processBind.fence ??= new ItemToolFence(descriptor);
	const fence = processBind.fence;
	installItemToolFence(pi, fence);
	// Every bind (main, a subagent's rebind, a task worker) before stock builds that session: see waste-guards-wait.ts.
	try {
		registerWait(pi);
	} catch (err) {
		pi.logger.error("gui-bridge: wait guard failed", { error: String(err) });
	}
	if (processBind.bound) {
		processBind.startLoading?.();
		const loaded = await processBind.bound;
		for (const install of loaded?.installs ?? []) install(pi);
		return;
	}
	if (!isMainThread) {
		// Stock reimports file extensions in its task workers. Install their hooks without replacing the main socket.
		processBind.bound = loadMethods(pi);
		await processBind.bound;
		return;
	}
	const first = Promise.withResolvers<LoadedMethods | undefined>();
	processBind.bound = first.promise;
	// The area modules load at their first use, not while omp starts: the first connection (main connects at
	// stock's `ready`), the first prompt (the gates below) or a subagent's rebind. Loaded here, their imports ran on
	// omp's one thread in the middle of its startup: `ready` came 69 ms later (median of 15 interleaved spawns with
	// OMPdesk's extensions, 14 of 15 later), the first `get_state` answer 59 ms later and the omp held 14 MB more at
	// idle (15 of 15), while the first bridge answer came no sooner (tmp/perf-bridge-startup, 30 Oct 2026).
	const firstUse = Promise.withResolvers<void>();
	processBind.startLoading = firstUse.resolve;

	// Stock picks the first session's thinking level right after the extensions
	// load, so the default must be in place before this factory returns. Dynamic
	// like AREAS: a vanished omp export must not fail the whole extension at link time.
	await import("./thinking-default")
		.then(module => module.applyGuiThinkingDefault(pi))
		.catch(err => pi.logger.error("gui-bridge: thinking default failed", { error: String(err) }));
	// Same timing for the delegation strength new tabs start with (the first prompt and tool set follow it).
	await import("./modes/delegation")
		.then(module => module.applyGuiDelegation(pi))
		.catch(err => pi.logger.error("gui-bridge: delegation strength failed", { error: String(err) }));
	// OMPdesk's own roles and agent tiers, before the first session can spawn a subagent (re-settled every turn).
	await import("./ompdesk-roles")
		.then(module => module.settleOmpdeskRoles(pi.pi.Settings.instance as unknown as RoleSettings))
		.catch(err => pi.logger.error("gui-bridge: OMPdesk roles failed", { error: String(err) }));
	// The main agent's `a2ui` tool, before stock builds the session (modes/a2ui.ts says why it is not an area hook).
	// Gated: an agent offered surfaces no window draws would wait on a form nobody can answer.
	if (A2UI_ENABLED || process.env.OMP_GUI_TEST_A2UI === "1")
		await import("./modes/a2ui")
			.then(module => module.registerA2ui(pi))
			.catch(err => pi.logger.error("gui-bridge: a2ui tool failed", { error: String(err) }));

	const loading = firstUse.promise.then(() => loadMethods(pi));
	// Requests rethrow a failed table; this logs it once, and a rebind then installs nothing.
	first.resolve(
		loading.catch(err => {
			pi.logger.error("gui-bridge: method table failed", { error: String(err) });
			return undefined;
		}),
	);
	// A prompt that comes before the areas loaded (one sent at `ready`, before main connected) starts the load and
	// waits for their hooks (prompt sections, recall, account rotation, roles, turn stages), bounded by the load
	// itself and by stock's handler timeout: stock walks this extension's handler list as it stands, so the hooks
	// installed during that wait run for the same prompt (bridge-first-use-stock.test.ts). Once loaded, the gates
	// return at once.
	let installed = false;
	void first.promise.then(() => {
		installed = true;
	});
	const gate = () => {
		if (installed) return undefined;
		firstUse.resolve();
		return first.promise.then(() => undefined);
	};
	pi.on("input", gate);
	pi.on("before_agent_start", gate);
	const clients = new Set<net.Socket>();
	let latestContext: ExtensionContext | undefined;
	const remember = (_event: unknown, ctx: ExtensionContext) => {
		latestContext = ctx;
	};
	pi.on("session_start", remember);

	const write = (socket: net.Socket, frame: unknown) => {
		if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
	};

	const env: BridgeEnv = {
		pi,
		session() {
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			if (!session) throw new Error("No live omp session");
			return session;
		},
		context() {
			if (!latestContext) throw new Error("omp session has not started yet");
			return latestContext;
		},
		emit(event: BridgeEvent) {
			for (const socket of clients) write(socket, { event });
		},
	};
	bindEnv(env);

	// A tree switch can replace the conversation without changing its file or stock session id.
	let sessionChanged = false;
	const change = (event: unknown, ctx: ExtensionContext) => {
		remember(event, ctx);
		if (!sessionChanged) {
			sessionChanged = true;
			env.emit({ type: "bot_session_changed" });
		}
	};
	pi.on("session_switch", change);
	pi.on("session_branch", change);
	pi.on("session_tree", change);

	const respond = async (method: unknown, params: unknown): Promise<unknown> => {
		if (method === "bot_session_unchanged") return !sessionChanged;
		const { table, failures } = await loading;
		const fn = typeof method === "string" && Object.hasOwn(table, method) ? table[method] : undefined;
		if (fn) return fn(params, env);
		// Most likely served by a module this omp could not load.
		if (failures.length > 0) throw new UnsupportedOmpError(mergeAreaFailures([], failures), pi.pi.VERSION);
		throw new Error(`Unknown bridge method: ${String(method)}`);
	};

	const handle = async (socket: net.Socket, line: string) => {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRequest(request)) return;
		const { id, method, params } = request;
		try {
			const result =
				method === "item_work.attach"
					? fence?.attach(socket, params) === true
					: method === "item_work.verdict"
						? fence?.answer(socket, params) === true
						: await respond(method, params);
			write(socket, { id, ok: true, result });
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			write(socket, { id, ok: false, error, ...(err instanceof UnsupportedOmpError ? { code: err.code } : {}) });
		}
	};

	const server = net.createServer(socket => {
		firstUse.resolve();
		clients.add(socket);
		if (sessionChanged) write(socket, { event: { type: "bot_session_changed" } });
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) void handle(socket, line);
				newline = buffer.indexOf("\n");
			}
		});
		socket.on("close", () => {
			fence?.disconnect(socket);
			clients.delete(socket);
		});
		socket.on("error", () => clients.delete(socket));
	});

	const isPipe = process.platform === "win32";
	// A previous crash can leave the socket file behind; listen() fails on it.
	if (!isPipe) fs.rmSync(address, { force: true });
	server.on("error", err => pi.logger.error("gui-bridge: socket error", { error: err.message }));
	server.listen(address);
	// The bridge must never be what keeps omp alive after it decides to exit.
	server.unref();
	process.once("exit", () => {
		server.close();
		if (!isPipe) fs.rmSync(address, { force: true });
	});
}
