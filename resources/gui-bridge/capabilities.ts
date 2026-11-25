/**
 * Compatibility self-check: every omp internal the bridge modules use, grouped
 * by the GUI capability that needs it. omp internals carry no semver, so after an
 * `omp update` a method can vanish; `capabilities` (index.ts) reports which
 * capabilities lost something, and `guard` (health.ts) fails their bridge methods
 * with a coded `unsupported_omp` error instead of a raw TypeError.
 *
 * One id per action a person sees: `guard(id, methods)` refuses every method of its
 * group when any internal listed under `id` is missing, so a group holds only methods
 * that use the same internals (a stated reason otherwise). A method that needs an
 * internal its siblings do not gets an id of its own, and the warning names that one
 * action, never a whole area (omp 19 dropped two handoff members and took ten composer
 * actions and the relaunch resume down with them while they shared one id).
 *
 * Pure on purpose: no omp imports (not even types) and no Bun globals, so the
 * GUI's own vitest/tsc can exercise the derivation with fake objects
 * (src/main/bridge-capabilities.test.ts). Keep the table in sync when a bridge
 * module starts using another internal.
 *
 * Requirement paths are dotted member paths. A trailing `()` requires a
 * function; anything else only has to exist (`in`, so optional getters count).
 * `a()|b()` accepts either name of a stock member renamed between supported versions.
 */

export const FEATURES = {
	core: "GUI bridge core",
	composerState: "Composer status (folder, auto-retry, thinking, agent pause, ultrafast)",
	ultrafast: "Ultrafast mode (/fast ultra)",
	pythonEval: "Python in the composer ($)",
	abortCompaction: "Cancel compaction",
	bashExcluded: "Bash kept out of context (!!)",
	clearContext: "Clear context",
	forceTool: "Forced tool",
	prewalk: "Prewalk",
	toolExtras: "Tool sources and mounted tools",
	contextReport: "/context report",
	jobs: "Background jobs list (/jobs)",
	cancelJob: "Cancel a background job",
	cycleModelBackward: "Previous model (backward model cycling)",
	relaunchResume: "Continuing interrupted turns and subagents after a relaunch",
	skillCount: "Skill count",
	dequeue: "Pull a queued message back into the composer",
	copyTargets: "/copy",
	lastLink: "/open (the last link)",
	localPaste: "Large pastes kept as local:// files",
	localLinks: "Opening local:// links",
	argCompletions: "Slash-command argument completion",
	share: "Session sharing",
	planMode: "Plan mode (on and off, and the plan the agent proposes as a card)",
	planApproval: "Plan approval (execute, compact, keep context, save, feedback)",
	guidedGoal: "Guided goal interview",
	goalReplace: "Changing an active goal's objective",
	goalBudget: "Goal token budget",
	goalTimeLimit: "Goal time limit",
	tan: "/tan background tangents",
	omfg: "/omfg rule forging",
	agentPause: "Agent pause",
	replyLanguage: "Reply language",
	nextPrompt: "Prompt suggestions (next message)",
	inlineCompletion: "Inline completion while typing in the composer",
	autoTitle: "Automatic session titles (first message, as the work changes, regenerate)",
	autoMode: "Automatic mode choice (Plan or Goal for a prompt)",
	autoModeUndo: "Undoing an automatic mode choice",
	judgeAssist: "Judge-model assists (needs-you notifications, title check, preview check)",
	memoryRecall: "Memory recall (earlier decisions and conclusions for a typed prompt)",
	outputStyle: "Output style (concise, detailed, minimal)",
	userProfile: "User profile (name, experience)",
	visuals: "Diagram instructions (Mermaid, SVG)",
	accountRotation: "Account rotation (even, quota re-rank at turn start and between model calls)",
	creditSpend: "Credit use off: an account whose plan is spent does not run on credits or extra usage",
	thinkingDefault: "Auto thinking by default",
	delegation: "Delegation strength (Solo to Swarm)",
	mcp: "MCP server list",
	mcpToggle: "Turning an MCP server on or off",
	mcpReconnect: "Reconnecting an MCP server",
	mcpRemove: "Removing an MCP server",
	mcpAdopt: "Using an MCP server another tool's config declares",
	mcpAdd: "Adding an MCP server",
	mcpTest: "MCP connection test",
	mcpReauth: "MCP server sign-in (OAuth)",
	mcpSync: "Following MCP changes another tab made",
	mcpReload: "MCP reload (/mcp reload)",
	mcpUpdateReconnect: "Reconnecting MCP servers after an extension update",
	plugins: "Installed plugins list",
	marketplaces: "Marketplaces and the plugins they offer",
	marketplaceEdit: "Adding, removing and updating a marketplace",
	pluginInstall: "Installing, uninstalling and upgrading a plugin",
	pluginToggle: "Turning a plugin on or off",
	pluginThemes: "Themes a plugin brings",
	pluginDetail: "Plugin details (features and settings)",
	pluginFeatures: "Plugin features on or off",
	pluginSettings: "Plugin settings",
	pluginReload: "Picking up plugin changes after an extension update",
	extensionUpdates: "Extension updates (plugins and registry skills, in the Updates section)",
	skills: "Skills list",
	ponytail: "Built-in Ponytail skills",
	skillDetail: "Skill preview",
	skillToggle: "Turning a skill on or off",
	manageSkill: "Creating, editing and deleting a managed skill",
	hooks: "Hooks list",
	hookToggle: "Turning a hook on or off",
	contextFiles: "Instruction files list (AGENTS.md and the like)",
	contextFileToggle: "Turning an instruction file on or off",
	promptTemplates: "Prompt templates list",
	agentValidate: "Checking an agent definition",
	agents: "Agent definitions list",
	agentDefinition: "One agent definition with its system prompt",
	agentAuthoring: "Agent folders and tool names for the agent editor",
	reviveSubagent: "Reviving a parked subagent",
	subagentTranscript: "A finished subagent's transcript",
	imageBlob: "Pictures read from omp's blob store (subagent transcripts, paired devices)",
	themes: "Themes",
	settingsSchema: "Settings page layout (tabs and every setting)",
	settings: "Settings (read and change)",
	imageGeneration: "Image generation turned on while a connected account can make images",
	models: "Model catalog",
	providers: "Providers list",
	providerLogout: "Disconnecting a provider",
	providerAccounts: "A provider's accounts (quota, health, pinned account)",
	storedCredentials: "Connected providers read outside a session (tool CLI updates, first-run sign-in check)",
	modelRoles: "Model roles",
	modelRoleMetadata: "Model role names and defaults",
	modelRoleSet: "Changing a model role",
	ompdeskRoles: "OMPdesk's own model roles and agent tiers (held at runtime)",
	modelSetupFacts: "Model setup (billing and model facts)",
	sessionSpend: "Session spend per provider (work board)",
	usage: "Usage (per-account reports and session totals)",
	usageHistory: "Usage totals across a session's whole journal",
	security: "Security dashboard (scans, findings, running operations)",
	securityScanDetail: "One security scan's findings",
	securityRun: "Starting and cancelling a security scan",
	securityDisposition: "Marking a security finding (false positive, accepted risk, fixed)",
	securityValidation: "Validation request for a security finding",
	ssh: "SSH hosts list",
	sshManage: "Adding, editing and deleting an SSH host",
	sshTest: "SSH connection test",
	dictation: "Dictation (speech to text)",
	readAloud: "Read aloud (text to speech)",
	debug: "Debug console",
	transcript: "Session transcript",
	entryIds: "Journal entry ids for live messages",
	sessionTree: "Session tree",
	entryLabel: "Labels on session tree entries",
	switchLeaf: "Moving to another branch of the session tree",
	forkFrom: "New session from a message",
	sessionPins: "Pinned sessions",
	sessionImport: "Claude/Codex session import",
	workspace: "Workspace directories list",
	resolvePath: "Resolving the folder a session moves to (/move)",
	workspaceEdit: "Adding and removing a workspace directory",
	moveStoredSession: "Moving a stored session to another project",
	compactionPoints: "Where compaction triggers for each model (context ring, roles)",
	compactionLimits: "Per-model compaction limits (checking and formatting an entry)",
	idleMaintenance: "Idle compaction and recap (compaction.idleEnabled, recap.enabled)",
	contextInspector: "Context inspector (per-entry tokens)",
	contextEntry: "Context inspector entry preview",
	promptOrigin: "Prompt origins (from another device)",
	typedPrompts: "Prompts a person typed, told to the omp (memory recall, answering first)",
	answerFirst: "A person's message that joins a running turn is answered in text before the next tool call",
	recentModels: "Recent models in the model picker",
	modelChoice: "The person's model on the composer while a fallback model runs the session",
	inputHistory: "Shared prompt history",
	accountPools: "Agent account pools",
	worktreeLocation: "Where a repository's worktrees are kept",
	prCheckout: "Checking out a pull request into a worktree",
	worktreeLifecycle: "Per-session worktrees (worktree.onStart / onExit)",
	worktreeBase: "Worktree folder read outside a session (for a paired device's agent)",
	resetPasses: "Saved rate-limit resets (reset passes)",
	streamMetadata: "Stock read grouping and live token rate",
	agentBrowser: "Agent browsing in the Preview panel (stock browser relay)",
	agentControl: "OMPdesk control tools (confirmation cards)",
	autopilot: "Autopilot (guarded, unattended Goal loop)",
	desktopSlot: "Desktop slot (one session drives the screen at a time)",
	phoneImages: "HEIC photos from a phone converted for the model",
	sessionOwner: "Opening a session only once another omp let go of it",
	pstack: "pstack engineering mode (always-on playbook section)",
	eccHint: "ECC skills named for the project's languages (prompt section)",
	formalHint: "Formal-verification skill named for race, retry and never-happens requests (prompt section)",
	defaultBrowser: "Default browser for agents: ego-browser, the user's own browser or built-in (prompt section)",
	computerUse: "Computer use engine: agent-desktop, falling back to the built-in prelude (prompt section, notice)",
	backgroundChecks: "Long checks run as background jobs (prompt section)",
	scratch: "A scratch folder per session for throwaway files (prompt section)",
	checkRuns: "Heavy commands and test suites through ompdesk run --heavy and ompdesk check (prompt section)",
	ciWatch: "CI results of a session's pushes reach that session (transcript line, no new turn)",
	checkoutPeers: "Sessions sharing a checkout (prompt section and git guard)",
	xdevNotice: "No mounted tool listed twice in a request (mount notice)",
	contextHookIdle: "Model requests not copied while the message filters have nothing to drop (recap, mount notice)",
	sessionDump: "Session dump archive saved as a file (/dump all, /dump anon)",
	advisorStats: "Advisor spend and advisories (Run popover, Insights)",
	todoReminder: "A refused todo call's reminder reaches its own turn, and the turn then reads finished",
	todoWait:
		"A session waiting on another session's reply, or whose open todo items are all written as waiting, is not woken by stock's todo reminder",
	todoStale: "A todo list left from earlier work is named to the agent when a new request starts a turn",
	todoCompact: "Keep unfinished todo items and append new work by phase",
	todoDrift:
		"The to-do panel says when the list last changed, which instructions came since, and marks a list behind the work",
	wasteGuards:
		"A bash service start whose ready.log cannot match is refused; a polling call or a refused edit is told once what to do instead; a wait returns only with news",
	quitJournal:
		"A quit lets a running command finish and journals every tool's result before the process ends; a relaunch never runs a command a second time",
	keptJobs: "A background command keeps running through an app restart, and its result still reaches the agent",
	exitDrain: "An omp that ends by itself finishes its exit cleanup first (a login refresh being saved)",
	turnStages: "Turn stages recorded when a turn waits long for the model or ends without output (gui-runtime.jsonl)",
	askForm: "An ask form's paragraphs, tables and pictures on its question card",
	imageSubscription: "Image generation only on the ChatGPT subscription's image model, never on a billed API key",
} as const;

export type FeatureId = keyof typeof FEATURES;

export interface FeatureRequirement {
	/** Members of the live AgentSession. */
	session?: readonly string[];
	/** Members of omp's package index (`env.pi.pi`). */
	pkg?: readonly string[];
	/** Members of the bridge's own ExtensionAPI instance (`env.pi`). */
	api?: readonly string[];
	/** Module specifier → export paths. */
	modules?: Readonly<Record<string, readonly string[]>>;
	/** omp prompt templates under `src/prompts` (see modes/shared.ts `ompPrompt`). */
	prompts?: readonly string[];
}

export interface UnavailableFeature {
	feature: FeatureId;
	missing: string[];
	/** A capability a core flow needs (`CORE_FEATURES`): main repairs omp only for these. */
	core?: true;
}

/**
 * Capabilities whose loss breaks a core flow, each with why. Only these start main's omp repair
 * (BridgeHealth `onIncompatible`); a missing optional action is reported and its methods refused, nothing more.
 */
export const CORE_FEATURES: Readonly<Partial<Record<FeatureId, string>>> = {
	core: "the bridge's registry access: without it no bridge method reaches the session",
	relaunchResume: "a relaunch would drop the turns and background subagents it cut, losing their work",
	sessionOwner: "a session another omp still holds could be opened twice, two writers on one journal",
};

const AGENT = "@oh-my-pi/pi-coding-agent";
const UTILS = "@oh-my-pi/pi-utils";

/** The union of requirement lists: an action that runs several of the bridge's helpers needs what each of them needs. */
function union(...parts: readonly FeatureRequirement[]): FeatureRequirement {
	const paths = (key: "session" | "pkg" | "api" | "prompts") => [...new Set(parts.flatMap(part => part[key] ?? []))];
	const modules: Record<string, string[]> = {};
	for (const part of parts) {
		for (const [specifier, exports] of Object.entries(part.modules ?? {})) {
			modules[specifier] = [...new Set([...(modules[specifier] ?? []), ...exports])];
		}
	}
	return { session: paths("session"), pkg: paths("pkg"), api: paths("api"), modules, prompts: paths("prompts") };
}

/** stream-metadata.ts `decorateMessages`: which read calls group, by stock's URL registry and read selector grammar. */
const READ_GROUPS: FeatureRequirement = {
	modules: {
		[`${AGENT}/internal-urls/router`]: ["InternalUrlRouter.instance()", "InternalUrlRouter.prototype.spec()"],
		[`${AGENT}/internal-urls/url-scheme`]: ["splitUrlScheme()"],
		[`${AGENT}/tools/details/read`]: ["splitPathAndSel()"],
	},
};

/** session-display.ts `buildTranscript`: stock's replay of the live journal. */
const TRANSCRIPT_REPLAY: FeatureRequirement = {
	session: ["sessionManager.getEntries()", "sessionManager.getLeafId()", "sessionManager.getBranch()"],
	modules: { [`${AGENT}/session/session-context`]: ["buildSessionContext()"] },
};

/** modes/plan.ts `exitPlanMode`: leaving plan mode, as a plan's approval and an undone automatic choice also do. */
const PLAN_EXIT: FeatureRequirement = {
	session: [
		"setPlanModeState()",
		"peekPlanProposalHandler()",
		"setPlanProposalHandler()",
		"setActiveToolsByName()",
		"sessionManager.getSessionId()",
		"sessionManager.appendModeChange()",
	],
};

/** modes/plan.ts `readPlan`: the plan file, through stock's reader and the session's local:// root. */
const PLAN_READ: FeatureRequirement = {
	session: ["sessionManager.getArtifactsDir()", "sessionManager.getSessionId()", "sessionManager.getCwd()"],
	modules: { [`${AGENT}/plan-mode/plan-files`]: ["readPlanFile()"] },
};

/** extensions/mcp.ts `listMcpServers`: user and project config, stock's discovery and the live manager's state. */
const MCP_LIST: FeatureRequirement = {
	session: [
		"settings",
		"settings.getAgentDir()",
		"effectiveExtensionRoots",
		"sessionManager.getCwd()",
		"modelRegistry.authStorage",
	],
	modules: {
		[`${AGENT}/capability`]: [
			"loadCapability()",
			"isForeignUserProvider()",
			"isProviderEnabled()",
			"isUserSourceEnabled()",
		],
		[`${AGENT}/mcp/config`]: ["loadAllMCPConfigs()"],
		[`${AGENT}/mcp/config-writer`]: ["readMCPConfigFile()"],
		[`${AGENT}/mcp/manager`]: [
			"MCPManager.instance()",
			"MCPManager.prototype.waitForStartup()",
			"MCPManager.prototype.getAllServerNames()",
			"MCPManager.prototype.getTools()",
			"MCPManager.prototype.getServerConfig()",
			"MCPManager.prototype.getConnectionStatus()",
		],
		[`${AGENT}/mcp/oauth-credentials`]: ["hasMcpAuthorizationHeader()", "lookupMcpOAuthCredential()"],
		[`${AGENT}/mcp/oauth-discovery`]: ["analyzeAuthError()"],
		[`${AGENT}/mcp/settings`]: ["cfgMcpEnableProjectConfig.get()"],
		[`${AGENT}/extensibility/inventory/mcp-runtime`]: ["inferMcpTransport()"],
		[UTILS]: ["getMCPConfigPath()"],
	},
};

/**
 * extensions/mcp.ts `reloadMcpServers`: stock's `MCPCommandController.reloadServers` on a context the bridge builds
 * (manager, session, settings), so what that controller asks of the session and the manager is listed; its warning
 * view is painted to text by stock's offline renderer in the plain theme.
 */
const MCP_RELOAD: FeatureRequirement = {
	session: [
		"settings",
		"effectiveExtensionRoots",
		"getEvalPreludes()",
		"getActiveToolNames()",
		"setMCPPromptCommands()",
		"refreshMCPTools()",
	],
	modules: {
		[`${AGENT}/modes/controllers/mcp-command-controller`]: ["MCPCommandController.prototype.reloadServers()"],
		"@oh-my-pi/pi-tui/term/render": ["renderBlock()"],
		"@oh-my-pi/pi-tui/theme/plain": ["PLAIN_THEME"],
		[`${AGENT}/mcp/manager`]: [
			"MCPManager.instance()",
			"MCPManager.prototype.disconnectAll()",
			"MCPManager.prototype.discoverAndConnect()",
			"MCPManager.prototype.getTools()",
		],
	},
};

/** extensions/mcp.ts `syncMcpServers`: this session's connections brought to what config and credentials say now. */
const MCP_SYNC: FeatureRequirement = {
	session: [
		"settings",
		"effectiveExtensionRoots",
		"sessionManager.getCwd()",
		"getEvalPreludes()",
		"refreshMCPTools()",
		"modelRegistry.authStorage.credentials.reload()",
	],
	modules: {
		[`${AGENT}/capability/fs`]: ["clearCache()"],
		[`${AGENT}/mcp/config`]: ["loadAllMCPConfigs()"],
		[`${AGENT}/mcp/settings`]: ["cfgMcpEnableProjectConfig.get()"],
		[`${AGENT}/mcp/manager`]: [
			"MCPManager.instance()",
			"MCPManager.prototype.getAllServerNames()",
			"MCPManager.prototype.getConnectionStatus()",
			"MCPManager.prototype.getServerConfig()",
			"MCPManager.prototype.disconnectServer()",
			"MCPManager.prototype.connectServers()",
			"MCPManager.prototype.getTools()",
		],
	},
};

/** extensions/shared.ts `createMarketplaceManager`: the manager `omp plugin` builds, rooted at the session's folder. */
const MARKETPLACE_MANAGER: FeatureRequirement = {
	session: ["sessionManager.getCwd()"],
	modules: {
		[`${AGENT}/discovery/helpers`]: ["clearPluginRootsAndCaches()", "resolveOrDefaultProjectRegistryPath()"],
		[`${AGENT}/extensibility/plugins/marketplace`]: [
			"getInstalledPluginsRegistryPath()",
			"getMarketplacesCacheDir()",
			"getMarketplacesRegistryPath()",
			"getPluginsCacheDir()",
		],
	},
};

/** extensions/shared.ts `reloadPluginState`: what stock's `/reload-plugins` runs headlessly. */
const PLUGIN_RELOAD: FeatureRequirement = {
	session: ["sessionManager.getCwd()", "refreshSkillsAndCommands()"],
	modules: {
		[`${AGENT}/discovery/helpers`]: ["clearPluginRootsAndCaches()", "resolveActiveProjectRegistryPath()"],
	},
};

/** extensions/shared.ts `classifyPluginActivation`: the effective plugins before and after a change. */
const PLUGIN_DIFF: FeatureRequirement = {
	modules: {
		[`${AGENT}/extensibility/plugins/loader`]: ["getEnabledPlugins()", "resolvePluginManifestEntries()"],
	},
};

/** extensions/plugins.ts `findPlugin`: an installed plugin by npm name or marketplace id. */
const PLUGIN_FIND: FeatureRequirement = union(MARKETPLACE_MANAGER, {
	modules: {
		[`${AGENT}/extensibility/plugins/loader`]: ["getEnabledPlugins()"],
		[`${AGENT}/extensibility/plugins/manager`]: [
			"PluginManager.prototype.list()",
			"PluginManager.prototype.getPlugin()",
		],
		[`${AGENT}/extensibility/plugins/marketplace`]: [
			"parsePluginId()",
			"MarketplaceManager.prototype.listInstalledPlugins()",
		],
	},
});

/** extensions/shared.ts `setExtensionDisabled`: an id toggled in `disabledExtensions` and flushed to config.yml. */
const EXTENSION_TOGGLE: FeatureRequirement = {
	session: ["settings", "settings.flush()"],
	modules: {
		[`${AGENT}/config/registry`]: [
			"lookup()",
			"Setting.prototype.get()",
			"Setting.prototype.setMember()",
			"Setting.prototype.provenance()",
		],
	},
};

/** extensions/skills.ts `listSkills`: stock's disabled-inclusive discovery against the session's loaded set. */
const SKILL_LIST: FeatureRequirement = {
	session: ["skills", "settings", "settings.getAgentDir()", "effectiveExtensionRoots", "sessionManager.getCwd()"],
	modules: {
		[`${AGENT}/capability`]: ["loadCapability()"],
		[`${AGENT}/autolearn/managed-skills`]: ["MANAGED_SKILLS_PROVIDER_ID"],
		[`${AGENT}/config/registry`]: ["lookup()", "Setting.prototype.get()"],
	},
};

/** settings.ts `syncImageGeneration`: the image tool held on while a connected account can make images. */
const IMAGE_TOOL: FeatureRequirement = {
	session: ["settings", "modelRegistry"],
	modules: {
		[`${AGENT}/config/registry`]: ["lookup()"],
		[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
	},
};

/** settings.ts `refreshCatalog`: credentials re-read, a bounded wait for stock's discovery, then the models. */
const MODEL_CATALOG: FeatureRequirement = union(IMAGE_TOOL, {
	session: [
		"getAvailableModels()",
		"modelRegistry.authStorage.credentials.reload()",
		"modelRegistry.refreshInBackground()",
		"modelRegistry.awaitBackgroundRefresh()",
		"modelRegistry.isBackgroundRefreshPending()",
		"modelRegistry.authStorage.oauth.accounts()",
		"modelRegistry.authStorage.keys.source()",
		"modelRegistry.hasCommandBackedApiKey()",
		"modelRegistry.refreshDiscoverableProviders()",
	],
	modules: {
		"@oh-my-pi/pi-ai": ["getEnvApiKeyName()"],
		[`${AGENT}/slash-commands/helpers/logout`]: ["listLogoutAccounts()"],
	},
});

/** settings.ts `buildProviders`: every provider with models, a login or a stored credential. */
const PROVIDER_LIST: FeatureRequirement = {
	session: [
		"sessionId",
		"settings",
		"getAvailableModels()",
		"modelRegistry.authStorage.credentials.list()",
		"modelRegistry.authStorage.keys.source()",
		"modelRegistry.authStorage.oauth.identity()",
		"modelRegistry.getProviderBaseUrl()",
	],
	modules: {
		"@oh-my-pi/pi-ai/oauth": ["getOAuthProviders()"],
		[`${AGENT}/config/registry`]: ["lookup()"],
		// An MCP server's sign-in shares the credential store: never a model provider.
		[`${AGENT}/mcp/oauth-flow`]: ["isManagedMCPOAuthCredentialId()"],
	},
};

/**
 * ompdesk-roles.ts `settleOmpdeskRoles`: OMPdesk's own roles and agent tiers, held in the runtime layer and never
 * persisted. Every model-role method settles them first.
 */
const ROLE_SETTLE: FeatureRequirement = {
	session: [
		"settings.overrideModelRoles()",
		"settings.overlayLayers()",
		"settings.getGlobalModelRole()",
		"settings.getProjectModelRole()",
		"settings.getGlobalSettings()",
		"settings.getProjectSettings()",
	],
	modules: {
		[`${AGENT}/config/registry`]: ["lookup()", "Setting.prototype.override()", "Setting.prototype.clearOverride()"],
		// The security reviewer's tier holds only while stock's bundled agent has no model line.
		[`${AGENT}/task/agents`]: ["getBundledAgent()"],
	},
};

/** settings.ts `roleMetadata`: every role of this omp and OMPdesk's own, with what stock knows of each. */
const ROLE_METADATA: FeatureRequirement = union(ROLE_SETTLE, {
	session: ["modelRegistry", "modelRegistry.getAll()"],
	modules: {
		[`${AGENT}/config/model-roles`]: ["getRoleInfo()", "getKnownRoleIds()", "MODEL_ROLE_IDS"],
		[`${AGENT}/config/model-resolver`]: ["rolePriorityDefaults()"],
		"@oh-my-pi/pi-catalog/types": ["modelKind()"],
	},
});

/**
 * security.ts `runSecurityTool`: stock's `security_scan` tool over this session, which holds the session's
 * coordinator (`security/coordinator` is not in omp's bundle: an import of it is a second copy with its own
 * settings registry).
 */
const SECURITY_TOOL: FeatureRequirement = {
	session: [
		"getAgentId()",
		"asyncJobManager",
		"sessionId",
		"model",
		"settings",
		"modelRegistry.authStorage",
		"sessionManager.getCwd()",
	],
	modules: { [`${AGENT}/tools/security-scan`]: ["SecurityScanTool.prototype.execute()"] },
};

/** model-setup-facts.ts `providerBillings`: each provider's billing class, from stock's own auth data. */
const PROVIDER_BILLING: FeatureRequirement = {
	session: [
		"modelRegistry.getDiscoverableProviders()",
		"modelRegistry.authStorage.credentials.list()",
		"modelRegistry.authStorage.keys.source()",
		"modelRegistry.authStorage.keys.keyless()",
	],
	modules: {
		"@oh-my-pi/pi-ai": ["getEnvApiKey()", "getProviderDefinition()"],
		[`${AGENT}/config/models-config`]: ["ModelsConfigFile.relocate()"],
		[UTILS]: ["getAgentDir()"],
	},
};

/** next-prompt-engine.ts `resolveModel` and `ask`: the cheap request suggestions and inline completion both make. */
const NEXT_PROMPT_REQUEST: FeatureRequirement = {
	session: [
		"messages",
		"settings",
		"sessionId",
		"modelRegistry.getApiKey()",
		"modelRegistry.resolver()",
		"sessionManager.getSessionId()",
		"sessionManager.getLeafId()",
	],
	modules: {
		"@oh-my-pi/pi-ai": ["completeSimple()"],
		[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
		[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
	},
};

export const REQUIREMENTS: Readonly<Record<FeatureId, FeatureRequirement>> = {
	core: {
		pkg: ["VERSION", "AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
	},
	/** stream_metadata.start: the live read grouping and the token rate, pushed while the session runs. */
	streamMetadata: union(READ_GROUPS, { session: ["subscribe()", "tokenRate.rate()"] }),
	/**
	 * browser.relay_start and browser.relay_stop (browser-relay.ts): stock's CDP server inside the
	 * session, with `browser.relay`/`browser.relayUrl` held as runtime overrides (handles via `lookup`). A relay that
	 * can be started but not stopped is not offered, and the session's shutdown hook stops it the same way.
	 */
	agentBrowser: {
		session: ["settings"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/tools/browser/relay/bridge`]: [
				"RelayBridge.prototype.extConnected()",
				"RelayBridge.prototype.extMessage()",
				"RelayBridge.prototype.extClosed()",
			],
			[`${AGENT}/tools/browser/relay/server`]: ["startRelayServer()"],
			[`${AGENT}/tools/browser/settings`]: [
				"cfgBrowserRelay.override()",
				"cfgBrowserRelay.clearOverride()",
				"cfgBrowserRelayUrl.override()",
				"cfgBrowserRelayUrl.clearOverride()",
			],
		},
	},
	composerState: {
		session: [
			"sessionManager.getCwd()",
			"autoRetryEnabled",
			"configuredThinkingLevel()",
			"isUltrafastModeEnabled()",
			"model",
		],
		modules: {
			"@oh-my-pi/pi-agent-core": ["agentPauseGate.paused", "agentPauseGate.pausedAt"],
			"@oh-my-pi/pi-ai": ["serviceTierFamily()", "shouldSendServiceTier()"],
		},
	},
	ultrafast: {
		session: ["setUltrafastMode()", "isFastModeEnabled()", "isFastModeActive()", "isUltrafastModeEnabled()"],
	},
	/** composer.eval and composer.abort_eval together: an eval that cannot be stopped is not started. */
	pythonEval: { session: ["executePython()", "abortEval()"] },
	abortCompaction: { session: ["abortCompaction()"] },
	bashExcluded: { session: ["executeBash()"] },
	clearContext: { session: ["resetSessionContext()"] },
	/** composer.get_force_tool reads what composer.set_force_tool queued: one id for both. */
	forceTool: {
		session: [
			"getActiveToolNames()",
			"toolChoiceQueue.pushSequence()",
			"toolChoiceQueue.removeByLabel()",
			"toolChoiceQueue.inspect()",
			"model",
		],
		modules: { [`${AGENT}/utils/tool-choice`]: ["buildNamedToolChoice()"] },
	},
	/** composer.prewalk_armed shows what composer.disarm_prewalk drops: an armed mark nobody can disarm is not shown. */
	prewalk: { session: ["getPrewalkState()", "disarmPrewalk()"] },
	toolExtras: { session: ["hasBuiltInTool()", "agent.state", "getToolCommandEntries()|getXdevToolEntries()"] },
	contextReport: { session: ["getContextBreakdown()", "model"] },
	jobs: {
		session: ["getAsyncJobTree()", "inspectAsyncJob()"],
		modules: { [`${AGENT}/modes/view-model/overlays/job-tree`]: ["buildJobTree()"] },
	},
	cancelJob: { session: ["cancelAsyncJob()"] },
	cycleModelBackward: { session: ["cycleModel()"] },
	/** composer.restore_interrupted: stock's `omp --restore` path plus the subagent and restart-note preparation. */
	relaunchResume: {
		session: [
			"restoreInterruptedTurn()",
			// A turn stock's restore continues gets the prompt sections set on its agent (prompt-sections.ts
			// `keepSectionsOnRestore`, wrapped on the AgentSession prototype).
			"agent.setSystemPrompt()",
			"baseSystemPrompt",
			"systemPrompt",
			"extensionRunner.createContext()",
			"getToolByName()",
			"sessionManager.getBranch()",
			"sessionManager.appendMessage()",
			"sessionManager.getSessionFile()",
			"promptCustomMessage()",
			// The restart notice for a turn stock's restore continues is queued at that turn's `turn_start`.
			"subscribe()",
			"isStreaming",
			"model",
			"getGoalModeState()",
			"asyncJobManager",
		],
		modules: {
			[`${AGENT}/task/restore`]: ["restoreSession()"],
			[`${AGENT}/session/exit-diagnostics`]: [
				"createInterruptedTurnAbortMessage()",
				"createInterruptedToolResults()",
				"hasRestorableTurn()",
			],
			// A subagent a graceful stop parked on an aborted reply, or cut in a call stock's exit record calls clean, gets
			// stock's "outcome unknown" results and interrupted-turn record appended through stock's writer before the
			// restore.
			[`${AGENT}/session/sub-sessions`]: ["collectSubSessions()"],
			[`${AGENT}/session/session-manager`]: [
				"SessionManager.open()",
				"SessionManager.prototype.appendMessage()",
				"SessionManager.prototype.close()",
				"extractSessionInit()",
			],
		},
	},
	skillCount: { session: ["skills"] },
	dequeue: { session: ["popLastQueuedMessage()", "getQueuedMessages()"] },
	/**
	 * With `buildTranscript`'s internals: the targets come from session-display's replay of the journal, the code and
	 * quote blocks from stock's markdown lexer (copy-targets.ts `markdownBlocks`).
	 */
	copyTargets: union(TRANSCRIPT_REPLAY, {
		modules: {
			[`${AGENT}/modes/view-model/overlays/copy-targets`]: ["commandFromToolCall()", "assistantText()"],
			"@oh-my-pi/pi-tui/text/markdown/lexer": ["lexMarkdown()"],
		},
	}),
	/** The newest link of the replayed transcript, as copyTargets. */
	lastLink: union(TRANSCRIPT_REPLAY, {
		modules: { [`${AGENT}/modes/view-model/overlays/copy-targets`]: ["extractLastLink()"] },
	}),
	localPaste: {
		session: ["sessionManager.getArtifactsDir()", "sessionManager.getSessionId()"],
		modules: {
			[`${AGENT}/internal-urls/local-protocol`]: ["resolveLocalRoot()"],
			[UTILS]: ["isEexist()"],
		},
	},
	localLinks: {
		session: ["sessionManager.getArtifactsDir()", "sessionManager.getSessionId()"],
		modules: { [`${AGENT}/internal-urls/local-protocol`]: ["resolveLocalUrlToPath()"] },
	},
	argCompletions: {
		modules: {
			[`${AGENT}/slash-commands/builtin-completions`]: ["buildMcpArgumentCompletions()"],
			[`${AGENT}/slash-commands/builtin-registry`]: ["BUILTIN_SLASH_COMMANDS"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
			[UTILS]: ["getProjectDir()"],
		},
	},
	/**
	 * composer.share_preview and composer.share: the upload sends the snapshot the preview showed (its digest binds
	 * the two), so an upload nobody could preview is not offered.
	 */
	share: {
		session: ["state", "obfuscator", "settings", "sessionManager"],
		modules: {
			[`${AGENT}/export/share`]: [
				"buildShareSnapshot()",
				"normalizeShareServerUrl()",
				"shareSession()",
				"sealToFit()",
				"SERVER_MAX_SEALED_BYTES",
			],
			[`${AGENT}/commands/settings`]: [
				"cfgShareServerUrl.get()",
				"cfgShareStore.get()",
				"cfgShareRedactSecrets.get()",
			],
		},
	},
	/**
	 * modes.get_plan_mode and modes.set_plan_mode with the proposal lifecycle they arm (modes/plan.ts): both install
	 * the proposal handler, and a session listener turns the agent's completed proposal into the plan card and
	 * stops the turn. Plan mode without that lifecycle would leave a proposal nobody sees, and nothing guards a
	 * listener, so its internals are listed here.
	 */
	planMode: union(PLAN_EXIT, PLAN_READ, {
		session: [
			"subscribe()",
			"getPlanModeState()",
			"preparePlanForReview()",
			"getGoalModeState()",
			"getPlanReferencePath()",
			"getEnabledToolNames()",
			"hasBuiltInTool()",
			"sendPlanModeContext()",
			"isStreaming",
			"markPlanInternalAbortPending()",
			"clearPlanInternalAbortPending()",
			"abort()",
		],
		modules: {
			[`${AGENT}/tools/resolve`]: ["proposeDispatchDetails()|writeDeviceDispatch()"],
		},
	}),
	/**
	 * modes.plan_approval: the card's answer (execute in a fresh session, compact, keep context, save, or feedback).
	 * A plan the automatic mode choice entered is approved by the same code, with "keep context".
	 */
	planApproval: union(PLAN_EXIT, PLAN_READ, {
		session: [
			"subscribe()",
			"isStreaming",
			"prompt()",
			"followUp()",
			"newSession()",
			"compact()",
			"setPlanReferencePath()",
			"markPlanReferenceSent()",
			"setSessionName()",
			"sessionManager.getSessionName()",
		],
		modules: {
			[`${AGENT}/plan-mode/approved-plan`]: ["humanizePlanTitle()"],
			[`${AGENT}/internal-urls`]: ["copyLocalArtifacts()", "resolveLocalUrlToPath()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/plan-mode-compact-instructions.md", "system/plan-mode-approved.md"],
	}),
	guidedGoal: {
		session: [
			"subscribe()",
			"settings",
			"getPlanModeState()",
			"getGoalModeState()",
			"getEnabledToolNames()",
			"setActiveToolsByName()",
			"isStreaming",
			"prompt()",
			"followUp()",
		],
		modules: {
			// `goal.enabled` through stock's registry: omp's bundle does not export `goals/settings` (see COPY_SAFE).
			[`${AGENT}/config/registry`]: ["lookup()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["goals/guided-goal-interview.md"],
	},
	goalReplace: {
		session: [
			"subscribe()",
			"getGoalModeState()",
			"setGoalModeState()",
			"goalRuntime.replaceGoal()",
			"isStreaming",
			"sendGoalModeContext()",
		],
	},
	goalBudget: { session: ["subscribe()", "getGoalModeState()", "goalRuntime.onBudgetMutated()"] },
	/**
	 * modes.goal_time_limit, modes.goal_set_time_limit and modes.goal_resume_time_limit with the watcher that enforces
	 * the limit (goal-time-core.ts): they read and write one journal entry, and a limit nothing reads back or enforces
	 * is not offered. The watcher is a session listener nothing guards, so its internals are listed here. Main pauses
	 * through stock RPC `goal pause`.
	 */
	goalTimeLimit: {
		session: [
			"subscribe()",
			"getGoalModeState()",
			"isStreaming",
			"sessionManager.getBranch()",
			"sessionManager.appendCustomEntry()",
		],
	},
	tan: {
		session: ["subscribe()", "sessionManager", "settings"],
		modules: {
			[`${AGENT}/modes/controllers/tan-command-controller`]: ["TanCommandController.prototype.start()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()"],
		},
	},
	omfg: {
		session: [
			"subscribe()",
			"runEphemeralTurn()",
			"ruleJudge()",
			"messages",
			"agent.state",
			"ttsrManager.addRule()",
			"model",
			"settings.getAgentDir()",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/modes/controllers/omfg-rule`]: [
				"parseGeneratedRule()",
				"extractGeneratedRuleJson()",
				"validateParsedRuleAgainstAssistantHistory()",
				"historyOutputs()",
				"buildOmfgRuleForPath()",
			],
			[`${AGENT}/session/ttsr-outputs`]: ["TtsrToolInspector()"],
			[`${AGENT}/capability`]: ["invalidate()"],
			[UTILS]: ["prompt.render()", "CONFIG_DIR_NAME"],
		},
		prompts: ["system/omfg-user.md"],
	},
	agentPause: {
		modules: {
			"@oh-my-pi/pi-agent-core": ["agentPauseGate.pause()", "agentPauseGate.resume()", "agentPauseGate.pausedAt"],
		},
	},
	/** Only the public `before_agent_start` hook; no internals to probe. */
	replyLanguage: {},
	/**
	 * agent-control.ts: the public extension context's `ui.confirm`, and `agent_control.judge` (`ompdesk_compare` with
	 * criteria): one request on stock's `advisor` role, then `slow`, through next-prompt-engine's `completeOnSmol`
	 * (`roleCandidatePool`, `resolveRoleChain`, the session's credentials, `completeSimple`). It prefers a candidate
	 * whose `Model.identity.class` (the vendor lineage) differs from the session's own model (`AgentSession.model`).
	 * Stored transcripts are read in the stock helper (`loadSessionMessagesReadOnly`, `stock-helper/sessions.ts`). A
	 * no-turn report holds while `isStreaming` and goes to the same `sessionId` once the turn ended.
	 * `agent_control.attachment` reads the live conversation's pictures (`AgentSession.messages`, a persisted one from
	 * stock's blob store as `read_image_blob` does) and a file in the session's folder (`sessionManager.getCwd()`).
	 * `agent_control.aside` hands a working session another session's message as stock's aside
	 * (`AgentSession.prompt` with `streamingBehavior: "aside"` and `onPromptAdmitted`). That aside, and a report that
	 * asks for a turn, are urgent while they wait in stock's aside queue: at each main run's start the bridge wraps the
	 * main agent's peek `Agent.hasIrcInterrupts` (found through `AgentRegistry`) to answer true then (read with
	 * `Agent.hasQueuedAsides`), so a running shell backgrounds.
	 */
	agentControl: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
		session: [
			"settings",
			"sessionId",
			"isStreaming",
			"prompt()",
			"model",
			"modelRegistry.getApiKey()",
			"modelRegistry.resolver()",
			"messages",
			"sessionManager.getCwd()",
			"agent.hasIrcInterrupts()",
			"agent.hasQueuedAsides()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["completeSimple()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/session/session-loader`]: ["loadSessionMessagesReadOnly()"],
			[`${AGENT}/session/blob-store`]: ["BlobStore()", "BlobStore.prototype.get()", "parseBlobRef()"],
			[UTILS]: ["getBlobsDir()"],
		},
	},
	/**
	 * modes/autopilot.ts: the tool set (`ask`/`eval`/`debug` off, the `autopilot` tool on), the session-only
	 * `tools.approvalMode` override, the cycle ledger in the journal, usage from the session stats, the todo
	 * list for stall classification, and the extension API's zod for the tool schema. One id for every run control
	 * (arm, configure, note, ship actions, cycle amendments, disarm): they write and read one run's ledger, and an
	 * unattended run is not armed on an omp where any of them (its stop included) cannot answer.
	 */
	autopilot: {
		pkg: ["AgentRegistry.global()", "MAIN_AGENT_ID", "z.object()", "z.enum()", "z.array()", "z.literal()"],
		session: [
			"subscribe()",
			"settings",
			"isStreaming",
			"getEnabledToolNames()",
			"getAllToolNames()",
			"setActiveToolsByName()",
			"getMountedToolCommandNames()|getMountedXdevToolNames()",
			"setActiveToolPresentation()",
			"getGoalModeState()",
			"getPlanModeState()",
			"getTodoPhases()",
			"getSessionStats()",
			"sessionManager.getBranch()",
			"sessionManager.appendCustomEntry()",
		],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	/** modes/output-style.ts: the same public hook as the reply language. */
	outputStyle: {},
	/**
	 * modes/checkout-peers.ts: public hooks (`before_agent_start`, `tool_call`, `tool_result`, `session_start`) and the
	 * journal. Stock's todo reader (`tools/todo` `getLatestTodoPhasesFromEntries`, for the session's current task) is
	 * feature-detected inside the module: a missing one only drops the task line, never the guard. One id for main's
	 * four calls (peers set and read back, status, retire): they are one ledger's two ends, and none of them calls an
	 * omp internal the others do not.
	 */
	checkoutPeers: {
		session: ["sessionManager.getBranch()"],
	},
	/** xdev-notice.ts: the public `context` hook and the context's `getSystemPrompt()` (checked at run time). */
	xdevNotice: {},
	/**
	 * context-hook.ts (the recap and mount-notice filters): stock's per-extension handler table behind `pi.on`, which
	 * a filter leaves while its session holds nothing to drop. Read at run time; without it the filters stay on every
	 * request (stock then copies the whole context before each one), so nothing else is refused.
	 */
	contextHookIdle: {
		api: ["extension.handlers"],
	},
	/** modes/pstack.ts: the always-on pstack section reads the main session's plan mode and tool set. */
	pstack: {
		pkg: ["AgentRegistry.global()", "MAIN_AGENT_ID"],
		session: ["getPlanModeState()", "getActiveToolNames()", "sessionManager.getBranch()"],
	},
	/** modes/ecc-hint.ts: the public `before_agent_start` hook and the context's `cwd` only. */
	eccHint: {},
	ponytail: union(MARKETPLACE_MANAGER, {
		session: ["sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/capability`]: ["registerProvider()", "getProviderInfo()"],
			[`${AGENT}/discovery/helpers`]: ["scanSkillsFromDir()"],
			[`${AGENT}/extensibility/plugins/marketplace`]: ["MarketplaceManager.prototype.listInstalledPlugins()"],
			[UTILS]: ["parseFrontmatter()"],
		},
	}),
	/** modes/formal-hint.ts: the public `before_agent_start` hook and its `prompt` only. */
	formalHint: {},
	/**
	 * modes/default-browser.ts: the public `before_agent_start` hook for the section, and `browser.enabled` held off as a
	 * runtime override of the session's settings (handles via `lookup`) while the picked browser cannot be verified.
	 */
	defaultBrowser: {
		pkg: ["Settings.instance"],
		session: ["settings"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/tools/browser/settings`]: ["cfgBrowserEnabled.override()", "cfgBrowserEnabled.clearOverride()"],
		},
	},
	/**
	 * modes/computer-use.ts: stock's MCP manager for the `agent-desktop` server's startup, `computer.enabled` by id
	 * (held on again on a fallback, thinking-default.ts), and the public `before_agent_start` hook for the section and
	 * the note.
	 */
	computerUse: {
		pkg: ["Settings.instance"],
		session: ["sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.instance()", "MCPManager.prototype.waitForStartup()"],
		},
	},
	/** modes/scratch.ts: only the public `before_agent_start` hook; no internals to probe. */
	scratch: {},
	/** modes/check-runs.ts: only the public `before_agent_start` hook; no internals to probe. */
	checkRuns: {},
	/**
	 * modes/ci-watch.ts: the public tool execution, `agent_end` and session hooks, the journal, the idle wait before a
	 * held result goes, and stock's `gh_run_watch` internals (loaded at the first push): the commit's runs and their
	 * outcome, a branch's head, the PR/commit reads through stock's `gh` runner, the PR-URL and repo-ref parsers and the
	 * rate-limit pattern.
	 */
	ciWatch: {
		api: ["sendMessage()"],
		session: [
			"isStreaming",
			"waitForIdle()",
			"sessionManager.getBranch()",
			"sessionManager.getCwd()",
			"sessionManager.appendCustomEntry()",
		],
		modules: {
			[`${AGENT}/tools/gh-run-watch`]: [
				"fetchRunsForCommit()",
				"getRunCollectionOutcome()",
				"getRunSnapshotOutcome()",
				"isFailedJob()",
				"resolveGitHubBranchHead()",
				"GH_RATE_LIMIT_ERROR_PATTERN",
			],
			[`${AGENT}/tools/gh-common`]: [
				"parsePullRequestUrl()",
				"parseRepoRef()",
				"ghApiHostArgs()",
				"defaultGhHost()",
				"GITHUB_HOST",
			],
			[`${AGENT}/utils/github`]: ["github.json()"],
		},
	},
	/** modes/background-checks.ts: reads stock `async.enabled` by id. */
	backgroundChecks: {
		pkg: ["Settings.instance"],
		session: ["sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	/** modes/user-profile.ts: the same public hook as the reply language. */
	userProfile: {},
	/** modes/visuals.ts: stock's Visuals prompt section, rendered with the tui.renderMermaid / tui.renderSvg settings. */
	visuals: {
		pkg: ["Settings.instance"],
		modules: {
			[`${AGENT}/modes/settings`]: ["cfgTuiRenderMermaid.get()", "cfgTuiRenderSvg.get()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["system/system-prompt.md"],
	},
	/**
	 * account-rotation.ts: even rotation and quota re-ranking pin a session's account through public AuthStorage
	 * namespaces. Quota re-ranking asks stock's selector (`keys.getWithCredential`, `recordAffinity: false`) for its
	 * pick, reads a pin's explicitness through `sessions.inherit`'s `include` callback, skips pooled sessions
	 * (`sessions.permits`) and accounts with a policy (`oauth.policy`), and orders two accounts' own reports
	 * (`credentials.list`, `usage.report`) with stock's comparator (`orderUsageRankedCandidates`). The between-calls
	 * check (`after_provider_response`) reads the running subagents (`AgentRegistry.list`, `isRunning`).
	 */
	accountRotation: {
		pkg: [
			"AgentRegistry.global()",
			"AgentRegistry.prototype.get()",
			"AgentRegistry.prototype.list()",
			"AgentRegistry.prototype.isRunning()",
		],
		session: [
			"sessionId",
			"modelRegistry.authStorage.oauth.accounts()",
			"modelRegistry.authStorage.oauth.policy()",
			"modelRegistry.authStorage.sessions.pin()",
			"modelRegistry.authStorage.sessions.inherit()",
			"modelRegistry.authStorage.sessions.permits()",
			"modelRegistry.authStorage.sessions.release()",
			"modelRegistry.authStorage.blocks.list()",
			"modelRegistry.authStorage.keys.getWithCredential()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.usage.report()",
			// The between-calls check hangs on this event (the extension runner's emit behind `after_provider_response`).
			"extensionRunner.emitAfterProviderResponse()",
		],
		modules: {
			"@oh-my-pi/pi-ai/auth/blocks": [
				"ACCOUNT_POLICY_BLOCK_SCOPE",
				"AUTH_BLOCK_SCOPE",
				"credentialBlockScopesForRequest()",
				"providerTypeKey()",
			],
			"@oh-my-pi/pi-ai/auth/rank": ["orderUsageRankedCandidates()", "planPriority()"],
			"@oh-my-pi/pi-ai/auth/usage-report": [
				"isUsageLimitExhausted()",
				"normalizeUsageFraction()",
				"remainingUsageFraction()",
				"scopedUsageLimits()",
				"windowRequiredDrain()",
			],
			"@oh-my-pi/pi-ai": ["resolveUsedFraction()"],
			"@oh-my-pi/pi-ai/usage/registry": ["defaultRankingStrategy()"],
			[`${AGENT}/session/credential-pin`]: ["credentialPinHash()"],
		},
	},
	/**
	 * credit-spend.ts: while credit use is off, ChatGPT's usage provider is stock's own wrapped as a runtime override
	 * (`usage.providerFor`, `usage.setProvider`, `usage.removeProvider`), and every account stock hands a request
	 * (`keys.getWithCredential`, and `oauth.access` for Codex web search and the live transport) is checked against the
	 * account's own report (`credentials.list`, `usage.report`, the model's own windows through the provider's ranking
	 * strategy) and Claude's last answer for the session's account (`oauth.accounts`), kept in a file of the agent
	 * directory (`getAgentDir`); a refusal carries stock's retry hint. `credit_spend_commit_check` asks the same checks
	 * about the models stock's `omp commit` would pick (`resolvePrimaryModel`, `resolveSmolModel`, `resolveApiKeyOnce`).
	 */
	creditSpend: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()"],
		session: [
			"modelRegistry.authStorage.keys.getWithCredential()",
			"modelRegistry.authStorage.oauth.access()",
			"modelRegistry.authStorage.usage.providerFor()",
			"modelRegistry.authStorage.usage.setProvider()",
			"modelRegistry.authStorage.usage.removeProvider()",
			"modelRegistry.authStorage.usage.report()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.oauth.accounts()",
		],
		modules: {
			"@oh-my-pi/pi-ai/utils/retry-after": ["appendRetryAfterHint()"],
			"@oh-my-pi/pi-ai/auth/usage-report": ["scopedUsageLimits()"],
			"@oh-my-pi/pi-ai/usage/registry": ["defaultRankingStrategy()"],
			"@oh-my-pi/pi-ai": ["resolveApiKeyOnce()"],
			[`${AGENT}/commit/model-selection`]: ["resolvePrimaryModel()", "resolveSmolModel()"],
			[UTILS]: ["getAgentDir()"],
		},
	},
	/** session-dump.ts: the two session methods `/dump all` and `/dump anon` run, called directly for their zip. */
	sessionDump: {
		session: ["dumpSessionArchiveToTmpDir()", "dumpAnonymizedArchiveToTmpDir()"],
		modules: { [`${UTILS}/ar`]: ["openArchive()", "encodeArchive()"] },
	},
	/** advisor-stats.ts: stock's advisor stats and branch. It imports nothing from omp, so health.ts has no LOADERS entry for it. */
	advisorStats: {
		session: ["getAdvisorStats()", "isAdvisorUsingSubscription()", "sessionManager.getBranch()"],
	},
	/** todo-reminder.ts: wraps the session's `sendCustomMessage` for stock's `todo-error-reminder`. Imports nothing from omp. */
	todoReminder: {
		session: ["sendCustomMessage()", "isStreaming"],
	},
	/**
	 * todo-wait.ts: wraps stock's `TodoTracker.prototype.checkCompletion` (marks the synchronous start of the check) and
	 * the session's `getActiveToolNames()` (answers without `todo` in that window when the session waits, stock's own
	 * "todo is off" path). Without either, stock's reminder stays as it is.
	 */
	todoWait: {
		session: ["getActiveToolNames()", "getTodoPhases()"],
		modules: {
			[`${AGENT}/session/todo-tracker`]: ["TodoTracker.prototype.checkCompletion()"],
		},
	},
	/** todo-stale.ts: stock's journal todo readers, the session's active tools and plan state, at each turn's start. */
	todoStale: {
		session: ["getActiveToolNames()", "getPlanModeState()", "sessionManager.getBranch()"],
		modules: {
			[`${AGENT}/tools/todo`]: ["getLatestTodoPhasesFromEntries()", "getLatestTodoSnapshotIdentity()"],
		},
	},
	/** todo-compact.ts: tool_call reads the calling agent's live list before stock can replace it. */
	todoCompact: { session: ["getTodoPhases()"] },
	/**
	 * todo-drift.ts: the public `tool_result` hook, stock's journal todo readers, the session's active tools and plan
	 * state after each tool call, its branch for the panel's reading, and one journaled marker per session.
	 */
	todoDrift: {
		session: [
			"getActiveToolNames()",
			"getPlanModeState()",
			"sessionManager.getBranch()",
			"sessionManager.getSessionId()",
			"sessionManager.appendCustomEntry()",
		],
		modules: {
			[`${AGENT}/tools/todo`]: ["getLatestTodoPhasesFromEntries()", "getLatestTodoSnapshotIdentity()"],
		},
	},
	/**
	 * waste-guards.ts: the public `tool_call` (`block`) and `tool_result` (`content`) hooks, `registerTool` over the
	 * built-in `wait` (waste-guards-wait.ts, from the factory) with the same-tool `ctx.invokeTool` (present since before
	 * 18.18.2), and on Windows stock's `WaitTool` from the package index over the process settings, which connects the
	 * folder's service broker client.
	 */
	wasteGuards: {
		pkg: ["WaitTool.prototype.execute()", "Settings.instance"],
	},
	/**
	 * quit-journal.ts: the public `tool_call` (`block`), `tool_execution_start`, `message_end`, `context` and
	 * `session_shutdown` hooks with the context's read-only `sessionManager` (`getEntries`, `getBranch`), and the
	 * session's agent loop reached through the registry to abort it once its running commands finished. Stock caps every
	 * `session_shutdown` handler at 2 s (`SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS`); its setter raises the cap past the
	 * stop's wait for commands. The embedded shell's `run`, wrapped once, records that a plain bash call's command
	 * started (`RAN_COMMANDS_FILE`), so a replay of a call that never ran is let through.
	 */
	quitJournal: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()"],
		session: ["agent.abort()"],
		modules: {
			[`${AGENT}/extensibility/extensions/runner`]: ["testSetSessionShutdownHandlerTimeoutMs()"],
			"@oh-my-pi/pi-natives": ["Shell.prototype.run()"],
		},
	},
	/**
	 * kept-jobs.ts: the public `tool_call` and `session_shutdown` hooks, the embedded shell's `run` (wrapped once for a
	 * background job's command, which runs as stock's shell process under `ompdesk keep`), the shell process's command
	 * line, and the bash tool's job manager, which the relaunch's restore registers a job still running again with.
	 */
	keptJobs: {
		pkg: ["MAIN_AGENT_ID"],
		session: ["getToolByName()", "sessionManager.getArtifactsDir()"],
		modules: {
			"@oh-my-pi/pi-natives": ["Shell.prototype.run()"],
			[`${AGENT}/exec/shell-process`]: ["shellProcessCommand()"],
		},
	},
	/**
	 * exit-drain.ts: the public `session_shutdown` hook of the main agent, and stock's `postmortem` for the awaited
	 * cleanup pass (`quit`), the native exit (`exitProcess`) and the key a stand-in for `process.exit` names it under.
	 */
	exitDrain: {
		pkg: ["MAIN_AGENT_ID"],
		modules: {
			[UTILS]: ["postmortem.quit()", "postmortem.exitProcess()", "postmortem.NATIVE_PROCESS_EXIT"],
		},
	},
	/**
	 * turn-stages.ts: the main session's `subscribe` and live `model`/`isStreaming`, and three instance methods wrapped
	 * once: `prompt` (a prompt's wait, and its setup ending before `agent_start`), `extensionRunner.emitBeforeAgentStart`
	 * (every extension's before_agent_start handlers) and `agent.streamFn` (the main loop's own provider requests).
	 * Imports nothing from omp.
	 */
	turnStages: {
		session: [
			"subscribe()",
			"prompt()",
			"model",
			"isStreaming",
			"extensionRunner.emitBeforeAgentStart()",
			"agent.streamFn()",
		],
	},
	/**
	 * desktop-slot.ts: patches stock's `ComputerSupervisor.prototype.run` (a read-only run passes, an acting run waits
	 * for the slot) and awaits `revokeControl()` on every supervisor it saw before the slot is handed on. Without
	 * either the bridge keeps stock behaviour.
	 */
	desktopSlot: {
		modules: {
			[`${AGENT}/tools/computer/supervisor`]: [
				"ComputerSupervisor.prototype.run()",
				"ComputerSupervisor.prototype.revokeControl()",
			],
		},
	},
	/**
	 * modes.get_delegation and modes.set_delegation (modes/delegation.ts): runtime overrides of stock's task settings,
	 * each handle reached through `lookup`. The chip reads the strength the setter holds, so a strength nobody can
	 * change is not shown. `Settings.instance` is the startup hold's (index.ts, before the first session), which
	 * nothing guards.
	 */
	delegation: {
		pkg: ["Settings.instance"],
		session: ["settings"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/task/settings`]: [
				"cfgTaskEager.override()",
				"cfgTaskEager.clearOverride()",
				"cfgTaskMaxConcurrency.override()",
				"cfgTaskMaxConcurrency.clearOverride()",
				"cfgTaskMaxRecursionDepth.override()",
				"cfgTaskMaxRecursionDepth.clearOverride()",
			],
		},
	},
	/**
	 * thinking-default.ts: OMPdesk's runtime-override defaults (`auto` for `defaultThinkingLevel`,
	 * "rpc" in `goal.continuationModes`, token usage, LSP diagnostics/format, ast_grep, the advisor;
	 * index.ts applies them before the first session, settings.ts re-checks them). Every handle is
	 * reached through `lookup` and a missing one is skipped (warned), so only the thinking level and its
	 * ceiling are probed here: the `session/settings` entries (`goal.continuationModes` is `lookup` only).
	 */
	thinkingDefault: {
		pkg: ["Settings.instance.getGlobalSettings()", "Settings.instance.getProjectSettings()"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/session/settings`]: [
				"cfgDefaultThinkingLevel.id",
				"cfgDefaultThinkingLevel.segments",
				"cfgDefaultThinkingLevel.isConfigured()",
				"cfgDefaultThinkingLevel.override()",
				"cfgDefaultThinkingLevel.clearOverride()",
				"cfgProvidersAutoThinkingMaxEffort.id",
				"cfgProvidersAutoThinkingMaxEffort.segments",
				"cfgProvidersAutoThinkingMaxEffort.isConfigured()",
				"cfgProvidersAutoThinkingMaxEffort.override()",
				"cfgProvidersAutoThinkingMaxEffort.clearOverride()",
			],
		},
	},
	mcp: MCP_LIST,
	/**
	 * mcp_action enable and disable: one config flag and stock's runtime toggle, so a server that can be turned off
	 * but not on again is not offered. A name no config or manager knows is looked up in the listed servers.
	 */
	mcpToggle: union(MCP_LIST, {
		session: ["getEvalPreludes()", "refreshMCPTools()"],
		modules: {
			[`${AGENT}/mcp/config-writer`]: ["setMcpServerEnabled()"],
			[`${AGENT}/modes/components/extensions/mcp-runtime`]: ["applyMcpToggleRuntime()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.prototype.getSource()"],
		},
	}),
	mcpReconnect: {
		session: ["sessionManager.getCwd()", "refreshMCPTools()"],
		modules: {
			[`${AGENT}/mcp/manager`]: [
				"MCPManager.instance()",
				"MCPManager.prototype.reconnectServer()",
				"MCPManager.prototype.getTools()",
				"MCPManager.prototype.getConnectionStatus()",
			],
		},
	},
	mcpRemove: union(MCP_RELOAD, {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/mcp/config-writer`]: ["readMCPConfigFile()", "removeMCPServer()"],
			[UTILS]: ["getMCPConfigPath()"],
		},
	}),
	/** mcp_action adopt: one server of another tool's config written into omp's own with stock's writer, then connected. */
	mcpAdopt: union(MCP_SYNC, {
		session: ["settings.getAgentDir()"],
		modules: {
			[`${AGENT}/capability`]: ["loadCapability()", "isForeignUserProvider()", "isUserSourceEnabled()"],
			[`${AGENT}/mcp/config-writer`]: ["addMCPServer()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.prototype.waitForStartup()"],
			[`${AGENT}/extensibility/inventory/mcp-runtime`]: ["inferMcpTransport()"],
			[UTILS]: ["getMCPConfigPath()"],
		},
	}),
	/** mcp_add: the write, stock's reload, then the new server's row from the list. */
	mcpAdd: union(MCP_LIST, MCP_RELOAD, { modules: { [`${AGENT}/mcp/config-writer`]: ["addMCPServer()"] } }),
	/** mcp_test: a throwaway manager and connection; the shared pool is never touched. */
	mcpTest: {
		session: ["sessionManager.getCwd()", "modelRegistry.authStorage"],
		modules: {
			[`${AGENT}/mcp/client`]: ["connectToServer()", "disconnectServer()", "listTools()"],
			[`${AGENT}/mcp/config`]: ["validateServerConfig()"],
			[`${AGENT}/mcp/config-writer`]: ["readMCPConfigFile()"],
			[`${AGENT}/mcp/manager`]: ["MCPManager.prototype.setAuthStorage()", "MCPManager.prototype.prepareConfig()"],
			[UTILS]: ["getMCPConfigPath()"],
		},
	},
	/** mcp_reauth: stock's own reauth, then the reload. mcp_reauth_cancel uses no omp internal and has no guard. */
	mcpReauth: union(MCP_RELOAD, {
		session: ["sessionManager.getCwd()", "modelRegistry.authStorage.credentials.set()"],
		modules: {
			[`${AGENT}/mcp/oauth-reauth`]: [
				"findMcpServerForAuth()",
				"reauthorizeMcpServer()",
				"MCPOAuthCancelledError()",
			],
			[`${AGENT}/mcp/settings`]: ["cfgMcpEnableProjectConfig.get()"],
			[UTILS]: ["Snowflake.next()"],
		},
	}),
	mcpSync: MCP_SYNC,
	/** mcp_reload: `/mcp reload` for the GUI, answered with the fresh list. */
	mcpReload: union(MCP_LIST, MCP_RELOAD, {
		session: ["modelRegistry.authStorage.credentials.reload()"],
		modules: { [`${AGENT}/capability/fs`]: ["clearCache()"] },
	}),
	/** extension_update.reconnect: the servers whose package the extension updater replaced. */
	mcpUpdateReconnect: {
		session: ["settings", "effectiveExtensionRoots", "sessionManager.getCwd()", "refreshMCPTools()"],
		modules: {
			[`${AGENT}/mcp/config`]: ["loadAllMCPConfigs()"],
			[`${AGENT}/mcp/settings`]: ["cfgMcpEnableProjectConfig.get()"],
			[`${AGENT}/mcp/manager`]: [
				"MCPManager.instance()",
				"MCPManager.prototype.getAllServerNames()",
				"MCPManager.prototype.reconnectServer()",
				"MCPManager.prototype.getTools()",
			],
		},
	},
	/** get_plugins: both install channels, npm packages and marketplace installs. */
	plugins: union(MARKETPLACE_MANAGER, {
		modules: {
			[`${AGENT}/extensibility/plugins/manager`]: ["PluginManager.prototype.list()"],
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"parsePluginId()",
				"MarketplaceManager.prototype.listInstalledPlugins()",
			],
		},
	}),
	/**
	 * get_marketplaces and marketplace_action list_available: the same cached catalogs, counted for the one and
	 * listed with what is installed for the other.
	 */
	marketplaces: union(MARKETPLACE_MANAGER, {
		modules: {
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"MarketplaceManager.prototype.listMarketplaces()",
				"MarketplaceManager.prototype.listAvailablePlugins()",
				"MarketplaceManager.prototype.listInstalledPlugins()",
			],
		},
	}),
	/** marketplace_action add, remove and update: a marketplace that can be added but not removed or refreshed is not offered. */
	marketplaceEdit: union(MARKETPLACE_MANAGER, PLUGIN_RELOAD, {
		modules: {
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"classifySource()",
				"MarketplaceManager.prototype.addMarketplace()",
				"MarketplaceManager.prototype.removeMarketplace()",
				"MarketplaceManager.prototype.updateMarketplace()",
				"MarketplaceManager.prototype.updateAllMarketplaces()",
			],
		},
	}),
	/** marketplace_action install, uninstall and upgrade: a plugin that can be installed but not removed or upgraded is not offered. */
	pluginInstall: union(MARKETPLACE_MANAGER, PLUGIN_RELOAD, PLUGIN_DIFF, {
		modules: {
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"MarketplaceManager.prototype.installPlugin()",
				"MarketplaceManager.prototype.uninstallPlugin()",
				"MarketplaceManager.prototype.upgradePlugin()",
			],
		},
	}),
	/** set_plugin_enabled: a marketplace install by its `name@marketplace` id, anything else as an npm package. */
	pluginToggle: union(MARKETPLACE_MANAGER, PLUGIN_RELOAD, PLUGIN_DIFF, {
		modules: {
			[`${AGENT}/extensibility/plugins/manager`]: ["PluginManager.prototype.setEnabled()"],
			[`${AGENT}/extensibility/plugins/marketplace`]: [
				"parsePluginId()",
				"MarketplaceManager.prototype.setPluginEnabled()",
			],
		},
	}),
	pluginThemes: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/extensibility/plugins/loader`]: ["getEnabledPlugins()"],
			[UTILS]: ["pathIsWithin()"],
		},
	},
	pluginDetail: union(PLUGIN_FIND, {
		modules: { [`${AGENT}/extensibility/plugins/manager`]: ["PluginManager.prototype.getPluginSettings()"] },
	}),
	pluginFeatures: union(PLUGIN_FIND, PLUGIN_DIFF, PLUGIN_RELOAD, {
		modules: { [`${AGENT}/extensibility/plugins/manager`]: ["PluginManager.prototype.setEnabledFeatures()"] },
	}),
	/** set_plugin_setting and delete_plugin_setting: a setting that can be set but not cleared is not offered. */
	pluginSettings: union(PLUGIN_FIND, PLUGIN_RELOAD, {
		modules: {
			[`${AGENT}/extensibility/plugins/manager`]: [
				"validateSetting()",
				"PluginManager.prototype.setPluginSetting()",
				"PluginManager.prototype.deletePluginSetting()",
			],
		},
	}),
	/** extension_update.reload: the headless `/reload-plugins` once the extension updater changed files on disk. */
	pluginReload: PLUGIN_RELOAD,
	/**
	 * The Updates section's extension updater. No bridge method uses these: the stock helper's `extensions` worker
	 * (stock-helper/extensions.ts) checks and upgrades plugins and registry skills in its own process, and the probe
	 * only reports whether this omp has what that worker loads.
	 */
	extensionUpdates: {
		modules: {
			[`${AGENT}/extensibility/plugins/manager`]: ["PluginManager.prototype.upgrade()"],
			[`${AGENT}/extensibility/plugins/marketplace`]: ["MarketplaceManager.prototype.checkForUpdates()"],
			[`${AGENT}/extensibility/plugins/git-url`]: ["parseGitUrl()"],
			[`${AGENT}/cli/npm-registry`]: ["loadNpmRegistryResolver()", "npmRegistryPackageUrl()"],
			// Registry-skill installs, and skill discovery for the plugin and local counts.
			[`${AGENT}/config/settings`]: ["Settings.loadReadOnly()", "Settings.prototype.extensionsSourceLevel()"],
			[`${AGENT}/discovery`]: ["initializeWithSettings()", "loadCapability()"],
			[`${AGENT}/extensibility/settings`]: ["cfgSkills.get()", "cfgDisabledExtensions.get()", "cfgExtensions.get()"],
			[`${AGENT}/extensibility/skills`]: ["loadSkills()"],
			[`${AGENT}/skillshare/client`]: [
				"SkillshareClient.create()",
				"SkillshareClient.prototype.packument()",
				"SkillshareClient.prototype.close()",
			],
			[`${AGENT}/skillshare/installer`]: ["listInstalledSkills()", "resolveSkillVersion()", "updateSkillPackages()"],
			[`${AGENT}/skillshare/manifest`]: ["getProjectSkillsInstallPaths()"],
			[UTILS]: ["getPluginsPackageJson()"],
		},
	},
	skills: SKILL_LIST,
	skillDetail: union(SKILL_LIST, { modules: { [UTILS]: ["parseFrontmatter()"] } }),
	skillToggle: union(EXTENSION_TOGGLE, { session: ["skills", "refreshSkills()"] }),
	/** manage_skill: writes go through stock's tool, the session's own per-skill mutation chain (see COPY_SAFE). */
	manageSkill: union(SKILL_LIST, {
		session: ["refreshSkills()"],
		modules: {
			[`${AGENT}/autolearn/managed-skills`]: ["sanitizeSkillName()"],
			[`${AGENT}/tools/manage-skill`]: ["ManageSkillTool.prototype.execute()"],
		},
	}),
	hooks: {
		session: ["settings", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/capability`]: ["loadCapability()"],
			[`${AGENT}/capability/hook`]: ["hookCapability.id"],
			[`${AGENT}/config/registry`]: ["lookup()", "Setting.prototype.get()"],
		},
	},
	hookToggle: EXTENSION_TOGGLE,
	contextFiles: {
		session: ["settings", "settings.getAgentDir()", "effectiveExtensionRoots", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/capability`]: ["loadCapability()"],
			[`${AGENT}/capability/context-file`]: ["contextFileCapability.id", "contextFileCapability.toExtensionId()"],
			[`${AGENT}/config/registry`]: ["lookup()", "Setting.prototype.get()"],
		},
	},
	/** set_context_file_enabled: the toggle, then the base prompt rebuilt from a fresh discovery. */
	contextFileToggle: union(EXTENSION_TOGGLE, {
		session: ["refreshBaseSystemPrompt()"],
		modules: { [`${AGENT}/capability`]: ["reset()"] },
	}),
	promptTemplates: {
		session: ["promptTemplates"],
		modules: { [`${AGENT}/config/prompt-templates`]: ["templateUsesInlineArgPlaceholders()"] },
	},
	agentValidate: {
		modules: {
			[`${AGENT}/discovery/helpers`]: ["parseAgentFields()"],
			[`${AGENT}/task/agents`]: ["AgentParsingError"],
			[UTILS]: ["parseFrontmatter()"],
		},
	},
	/** get_agent_definitions: stock's agents hub, with the model and prewalk each definition resolves to. */
	agents: {
		session: [
			"settings",
			"settings.getModelRole()",
			"model",
			"modelRegistry",
			"effectiveExtensionRoots",
			"sessionManager.getCwd()",
		],
		modules: {
			[`${AGENT}/config`]: ["getConfigDirs()", "findAllNearestProjectConfigDirs()"],
			[`${AGENT}/config/model-resolver`]: ["formatModelString()"],
			[`${AGENT}/modes/agents-hub-deps`]: ["createAgentsHubDeps()"],
		},
	},
	agentDefinition: {
		session: ["effectiveExtensionRoots", "sessionManager.getCwd()"],
		modules: { [`${AGENT}/task/discovery`]: ["discoverAgents()"] },
	},
	agentAuthoring: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/config`]: ["getConfigDirs()", "findAllNearestProjectConfigDirs()"],
			[`${AGENT}/tools/builtin-names`]: ["BUILTIN_TOOL_NAMES", "HIDDEN_TOOL_NAMES"],
		},
	},
	reviveSubagent: {
		modules: {
			[`${AGENT}/registry/agent-lifecycle`]: [
				"AgentLifecycleManager.global()",
				"AgentLifecycleManager.prototype.ensureLive()",
			],
			[`${AGENT}/registry/agent-registry`]: [
				"AgentRegistry.global()",
				"AgentRegistry.prototype.get()",
				"MAIN_AGENT_ID",
			],
		},
	},
	subagentTranscript: {
		session: ["sessionManager.getArtifactsDir()"],
		modules: { [`${AGENT}/modes/rpc/rpc-subagents`]: ["readRpcSubagentTranscript()"] },
	},
	imageBlob: {
		modules: {
			[`${AGENT}/session/blob-store`]: ["BlobStore()", "BlobStore.prototype.get()", "parseBlobRef()"],
			[UTILS]: ["getBlobsDir()"],
		},
	},
	/** The package index's theme service (`ui/theme/service`, which omp's bundle registers only through the root). */
	themes: { pkg: ["getResolvedThemeColors()"] },
	/** settings_schema, guarded with thinkingDefault too: it re-checks OMPdesk's thinking defaults first. */
	settingsSchema: {
		session: ["settings"],
		modules: {
			[`${AGENT}/config/all-settings`]: ["orderedSettings()"],
			[`${AGENT}/config/settings-defs`]: ["SETTING_TABS", "TAB_GROUPS"],
			[`${AGENT}/ui/overlays/settings/pages`]: ["SETTINGS_PAGES"],
			[UTILS]: ["getAgentDir()", "MAIN_CONFIG_FILENAMES"],
		},
	},
	/**
	 * settings_get and settings_set, guarded with thinkingDefault too: a write answers with the value and the layers a
	 * read reports, so a page that shows settings it cannot change is not offered.
	 */
	settings: {
		session: ["settings", "model", "thinkingLevel"],
		modules: {
			[`${AGENT}/config/all-settings`]: ["orderedSettings()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[UTILS]: ["getAgentDir()", "MAIN_CONFIG_FILENAMES"],
		},
	},
	/**
	 * image_generation_sync: the credentials re-read after a login or logout in any tab, and the watcher that follows
	 * this omp's own (the Setting override methods and `onGeneration` are feature-detected).
	 */
	imageGeneration: union(IMAGE_TOOL, {
		session: [
			"modelRegistry.authStorage.credentials.reload()",
			"modelRegistry.refreshInBackground()",
			"modelRegistry.awaitBackgroundRefresh()",
		],
	}),
	models: MODEL_CATALOG,
	/** providers: the list, answered with the catalog its model counts come from. */
	providers: union(MODEL_CATALOG, PROVIDER_LIST),
	/** provider_logout: stock's `logoutCredential(session, …)` refreshes the session's scoped models itself (omp 18.18.2). */
	providerLogout: union(IMAGE_TOOL, PROVIDER_LIST, {
		session: ["modelRegistry.authStorage", "refreshScopedModels()"],
		modules: { [`${AGENT}/slash-commands/helpers/logout`]: ["listLogoutAccounts()", "logoutCredential()"] },
	}),
	/**
	 * provider_accounts: per-account quota, health and the session's pinned account. `refresh` is stock's
	 * `omp usage invalidate`, and every read keys stock's usage cache by the provider's base URL, as fetchUsageReports,
	 * header ingestion and credential selection do.
	 */
	providerAccounts: {
		session: [
			"sessionId",
			"model",
			"modelRegistry.getProviderBaseUrl()",
			"modelRegistry.authStorage.credentials.reload()",
			"modelRegistry.authStorage.credentials.list()",
			"modelRegistry.authStorage.oauth.accounts()",
			"modelRegistry.authStorage.health.model()",
			"modelRegistry.authStorage.usage.report()",
			"modelRegistry.authStorage.usage.invalidate()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["resolveUsedFraction()"],
			"@oh-my-pi/pi-ai/oauth": ["getOAuthCredentialProvider()"],
		},
	},
	/**
	 * No bridge method uses these: the stock helper (stock-helper/accounts.ts) reads the connected providers for the
	 * Updates section's tool CLIs and asks at first run whether any credential exists, in its own process.
	 */
	storedCredentials: {
		modules: {
			[`${AGENT}/sdk`]: ["discoverAuthStorage()"],
			"@oh-my-pi/pi-ai": ["listProvidersWithEnvKey()", "getEnvApiKey()"],
		},
	},
	/** model_roles: each role's value, source, effective model and candidates. */
	modelRoles: union(ROLE_METADATA, {
		session: ["model", "settings.getModelRole()", "settings.getModelRoleSource()"],
		modules: {
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()", "CHAT_MODEL_ROLE_IDS"],
			[`${AGENT}/config/model-resolver`]: [
				"disabledProviderIds()",
				"resolveModelOverride()",
				"resolveRoleChain()",
				"resolveRoleSelection()",
			],
		},
	}),
	modelRoleMetadata: ROLE_METADATA,
	/** model_role_set: a stock role into config.yml, an OMPdesk role into the picks file and the runtime layer. */
	modelRoleSet: union(ROLE_SETTLE, {
		session: ["model", "thinkingLevel", "modelRegistry.getAll()", "settings.setModelRole()", "settings.flush()"],
		modules: { [`${AGENT}/config/model-resolver`]: ["extractExplicitThinkingSelector()"] },
	}),
	/**
	 * ompdesk-roles.ts hooks, no bridge method: the held roles settle before each turn and when `modelRoles` changes,
	 * a saved preset never carries them, and a user's own agent keeps its model line over a held tier. Nothing guards
	 * a hook, so their internals are listed here.
	 */
	ompdeskRoles: union(ROLE_SETTLE, {
		session: ["effectiveExtensionRoots"],
		modules: {
			[`${AGENT}/config/registry`]: [
				// The `modelPresets` handle's writes drop the roles OMPdesk holds.
				"Setting.prototype.setEntry()",
				// A `/modelpreset switch` clears held roles; a `modelRoles` change re-holds them.
				"Setting.prototype.listen()",
			],
			[`${AGENT}/task/discovery`]: ["discoverAgents()", "getAgent()"],
		},
	}),
	/**
	 * model_setup_facts (model-setup-facts.ts): the models of every role's pool, each provider's billing, what
	 * config.yml persists per role (`getGlobalModelRole`: its absence would let full auto overwrite a hand-set role, so
	 * it is required, not feature-detected) and stock's judge defaults.
	 */
	modelSetupFacts: union(ROLE_METADATA, PROVIDER_BILLING, {
		modules: {
			[`${AGENT}/config/model-resolver`]: ["resolveModelOverride()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
		},
	}),
	/**
	 * session_spend: the live journal's spend per provider with that provider's billing (work board: a metered charge
	 * apart from a subscription's estimate).
	 */
	sessionSpend: union(PROVIDER_BILLING, { session: ["sessionManager.getEntries()", "modelRegistry.getAll()"] }),
	/** usage: one report per stored account and the session's own tallies; `refresh` is stock's `omp usage invalidate`. */
	usage: {
		session: [
			"fetchUsageReports()",
			"sessionId",
			"sessionManager.getUsageStatistics()",
			"modelRegistry.authStorage.oauth.accounts()",
			"modelRegistry.authStorage.usage.invalidate()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["resolveUsedFraction()"],
			"@oh-my-pi/pi-ai/auth/usage-report": ["usageResetAtMs()"],
			[`${AGENT}/slash-commands/helpers/active-oauth-account`]: [
				"reportMatchesActiveAccount()",
				"formatActiveAccountLabel()",
			],
		},
	},
	/** sessions.usage_history: totals across the whole live journal, with every compaction it records. */
	usageHistory: { session: ["sessionManager.getUsageStatistics()", "sessionManager.getEntries()"] },
	/** security_dashboard: the stored scans, the repository's revision and each operation's status from stock's tool. */
	security: union(SECURITY_TOOL, {
		modules: {
			"@oh-my-pi/pi-natives/vcs": ["git()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/security/store`]: [
				"SecurityStore.openForCwd()",
				"SecurityStore.prototype.listScans()",
				"SecurityStore.prototype.getBundle()",
			],
		},
	}),
	securityScanDetail: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/security/store`]: ["SecurityStore.openForCwd()", "SecurityStore.prototype.getBundle()"],
		},
	},
	/** security_start and security_cancel: both through stock's tool; a scan that cannot be cancelled is not started. */
	securityRun: SECURITY_TOOL,
	securityDisposition: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/security/store`]: ["SecurityStore.openForCwd()", "SecurityStore.prototype.updateDisposition()"],
		},
	},
	securityValidation: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/security/store`]: ["SecurityStore.openForCwd()", "SecurityStore.prototype.getFinding()"],
			[UTILS]: ["prompt.render()"],
		},
		prompts: ["security/validate-request.md"],
	},
	/** ssh_hosts: stock's discovery, with the host facts its connection manager has cached. */
	ssh: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/capability/ssh`]: ["sshCapability.id"],
			[`${AGENT}/discovery`]: ["loadCapability()"],
			[`${AGENT}/ssh/connection-manager`]: ["getHostInfoForHost()"],
			[UTILS]: ["$which()"],
		},
	},
	/** ssh_manage create, update and delete: one method, and a host that can be added but not removed is not offered. */
	sshManage: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/discovery`]: ["reset()"],
			[`${AGENT}/ssh/config-writer`]: [
				"readSSHConfigFile()",
				"removeSSHHost()",
				"updateSSHHost()",
				"validateHostName()",
			],
			[`${AGENT}/ssh/connection-manager`]: ["invalidateHostMetadata()"],
			[UTILS]: ["getSSHConfigPath()"],
		},
	},
	/** ssh_test: stock's connection, and after a failure the OpenSSH client's own verbose trace. */
	sshTest: {
		modules: {
			[`${AGENT}/ssh/config-writer`]: ["validateHostName()"],
			[`${AGENT}/ssh/connection-manager`]: ["ensureConnection()", "ensureHostInfo()"],
			[`${AGENT}/ssh/utils`]: ["buildSshTarget()"],
			[UTILS]: ["$which()", "ptree.exec()"],
		},
	},
	/**
	 * transcribe_audio and stt_prepare: prepare is dictation's own setup (it gets the model the speech's language
	 * needs, and transcription waits on the same download), so dictation that cannot be prepared is not offered.
	 */
	dictation: {
		session: ["settings", "modelRegistry"],
		modules: {
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/stt/asr-client`]: ["sttClient.transcribe()"],
			[`${AGENT}/stt/downloader`]: ["downloadSttModel()", "isSttModelCached()"],
			[`${AGENT}/stt/models`]: ["resolveSttModelSpec()"],
		},
	},
	/** synthesize_speech: the only action that evaluates the `tts/*` source copies (HEAVY_COPIES). */
	readAloud: {
		session: ["settings", "modelRegistry"],
		modules: {
			[`${AGENT}/config/registry`]: ["lookup()"],
			[`${AGENT}/tts/models`]: ["DEFAULT_TTS_VOICE", "TTS_LOCAL_MODELS"],
			[`${AGENT}/tts/tts-client`]: ["ttsClient.synthesize()"],
			[`${AGENT}/tools/tts`]: ["resolveSpeechCandidates()"],
			[`${AGENT}/tts/wav`]: ["encodeWav()"],
		},
	},
	debug: {
		session: ["settings", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/tools/debug`]: ["DebugTool.prototype.execute()"],
		},
	},
	/**
	 * sessions.transcript: stock's replay in pages. With `imageRefs` (a paired device) a page names its pictures by
	 * stock's blob reference (image-refs.ts).
	 */
	transcript: union(TRANSCRIPT_REPLAY, READ_GROUPS, {
		session: ["sessionManager.getSessionFile()"],
		modules: {
			[`${AGENT}/session/blob-store`]: ["BlobStore()", "externalizeImageDataSync()", "isBlobRef()"],
			[`${AGENT}/session/session-persistence`]: ["isExternalizableImagePosition()"],
			[UTILS]: ["getBlobsDir()"],
		},
	}),
	entryIds: union(READ_GROUPS, {
		session: ["sessionManager.getEntries()"],
		modules: {
			[`${AGENT}/session/turn-persistence`]: ["sessionMessagePersistenceKey()", "sameMessageContent()"],
		},
	}),
	sessionTree: {
		session: [
			"sessionManager.getTree()",
			"sessionManager.getLeafId()",
			"sessionManager.getBranch()",
			"sessionManager.getLabel()",
		],
	},
	entryLabel: { session: ["sessionManager.appendLabelChange()"] },
	switchLeaf: { session: ["isStreaming", "navigateTree()", "sessionManager.getLeafId()"] },
	/** sessions.fork_from: an independent copy of one branch, written through a second manager on the same file. */
	forkFrom: {
		session: [
			"sessionManager.getSessionFile()",
			"sessionManager.getSessionDir()",
			"sessionManager.getCwd()",
			"sessionManager.flush()",
		],
		modules: {
			[`${AGENT}/session/session-manager`]: [
				"SessionManager.open()",
				"SessionManager.prototype.createBranchedSession()",
				"SessionManager.prototype.getEntry()",
				"SessionManager.prototype.getBranch()",
				"SessionManager.prototype.getChildren()",
				"SessionManager.prototype.flush()",
				"SessionManager.prototype.close()",
				"SessionManager.prototype.getSessionId()",
			],
		},
	},
	/** sessions.set_pinned: omp's pins file, written under stock's cross-process lock (session-pins.ts). */
	sessionPins: {
		modules: {
			[`${AGENT}/session/session-pins`]: ["loadPinnedSessionIds()"],
			[`${AGENT}/utils/atomic-file`]: ["replaceFileAtomically()"],
			[UTILS]: ["getAgentDir()", "withFileLock()"],
		},
	},
	/**
	 * sessions.foreign_list and sessions.foreign_import: the list is the import's own picker (an import reads the same
	 * listing), so a list nobody can import from is not shown.
	 */
	sessionImport: {
		session: ["sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/session/foreign-session-import`]: ["createForeignSessionStore()", "persistForeignSession()"],
			[`${AGENT}/session/session-loader`]: ["loadSessionFile()"],
			[`${AGENT}/session/session-manager`]: ["SessionManager.getDefaultSessionDir()"],
			[UTILS]: ["directoryExists()", "withFileLock()"],
		},
	},
	workspace: { session: ["sessionManager.getCwd()", "sessionManager.getAdditionalDirectories()"] },
	/** workspace.resolve_path: the folder `/move` takes a live session to, resolved as stock's tools resolve a path. */
	resolvePath: {
		session: ["sessionManager.getCwd()"],
		modules: { [`${AGENT}/tools/path-utils`]: ["resolveToCwd()"] },
	},
	/** workspace.add_directory and workspace.remove_directory: a folder that can be added but not removed is not offered. */
	workspaceEdit: {
		session: [
			"isStreaming",
			"refreshBaseSystemPrompt()",
			"sessionManager.getCwd()",
			"sessionManager.getAdditionalDirectories()",
			"sessionManager.addWorkspaceDirectory()",
			"sessionManager.removeWorkspaceDirectory()",
		],
		modules: { [`${AGENT}/session/session-workspace`]: ["normalizeWorkspaceDirectory()"] },
	},
	/**
	 * No bridge method uses these: the sidebar's "Move to project" moves a stored session in the stock helper
	 * (stock-helper/sessions.ts), in its own process.
	 */
	moveStoredSession: {
		modules: {
			[`${AGENT}/session/session-manager`]: [
				"SessionManager.open()",
				"SessionManager.prototype.moveTo()",
				"SessionManager.prototype.getSessionFile()",
				"SessionManager.prototype.close()",
			],
		},
	},
	/**
	 * input-history.ts writes (`open`, `add`, `shouldSkipHistory`) through the tab's omp; stock-helper/history.ts reads
	 * (`getRecent`, `search`) in the helper's stock worker, on the one history.db every omp on the machine shares.
	 */
	inputHistory: {
		session: ["sessionManager.getSessionId()"],
		modules: {
			[`${AGENT}/session/history-storage`]: [
				"HistoryStorage.open()",
				"HistoryStorage.prototype.getRecent()",
				"HistoryStorage.prototype.search()",
				"HistoryStorage.prototype.add()",
			],
			[`${AGENT}/modes/controllers/input-controller`]: ["shouldSkipHistory()"],
		},
	},
	/**
	 * modes/next-prompt.ts: a cheap request on stock's `smol` role (`resolveRoleChain` over `roleCandidatePool`, the
	 * session's credentials through `modelRegistry.resolver`, `completeSimple`); `runEphemeralTurn` cannot take another
	 * model. Reads of the todo, plan and goal state, the running async jobs (`getAsyncJobTree`), the usage ledger
	 * (`appendModelUsage`) and the loaded-extension list are feature-detected inside the module (they only enrich the
	 * request). One id for the settings, state, draft, refresh, children and cancel calls: they drive one scheduler,
	 * whose requests the `agent_end`, compaction and session-switch hooks start, and nothing guards a hook.
	 */
	nextPrompt: union(NEXT_PROMPT_REQUEST, { session: ["isStreaming", "isCompacting", "queuedMessageCount"] }),
	/**
	 * next_prompt_inline: the same cheap request for the draft being typed. It alone reads stock's secret-draft rule
	 * (`shouldSkipHistory`: such a draft never leaves the machine), so it is refused, never run, without it.
	 */
	inlineCompletion: union(NEXT_PROMPT_REQUEST, {
		modules: { [`${AGENT}/modes/controllers/input-controller`]: ["shouldSkipHistory()"] },
	}),
	/**
	 * modes/auto-title.ts: stock's own title machinery on the live session: `generateTitle` (the title model
	 * roles, `title-generator.ts`), `renameTitle` (`/rename` without a title: the card per `title.icons`),
	 * `SessionManager.setSessionName(name, source, trigger)` and the journal's `title_change` entries (the title's
	 * origin). `operatorTitleText` names what an operator message is about. The title language: the session's
	 * TITLE_SYSTEM.md slot (`titleSystemPrompt`, `setTitleSystemPrompt`) holds stock's own `title-system.md`
	 * (rendered with `prompt.render`) plus one language line; `title-card` splits a card off a title cut to length,
	 * and `title.icons` (`cfgTitleIcons`) says whether a fresh title drops the card stock's retitle kept. A title over
	 * the limits gets one retry on the `default` role's model (`roleCandidatePool`, `resolveRoleChain`, the session's
	 * credentials, `completeSimple`), its answer checked by stock's `normalizeGeneratedTitle`. One id for
	 * auto_title_set and regenerate_title: both attach the session's title listener, and the ✨ button asks for the
	 * title that listener makes, with the same machinery.
	 */
	autoTitle: {
		session: [
			"settings",
			"sessionId",
			"modelRegistry.getApiKey()",
			"modelRegistry.resolver()",
			"subscribe()",
			"sessionName",
			"generateTitle()",
			"renameTitle()",
			"titleSystemPrompt",
			"setTitleSystemPrompt()",
			"sessionManager.getSessionId()",
			"sessionManager.getSessionName()",
			"sessionManager.setSessionName()",
			"sessionManager.getEntries()",
			"sessionManager.titleSource",
			"sessionManager.titleRevision",
			"sessionManager.appendCustomEntry()",
			"sessionManager.onSessionNameChanged()",
			"messages",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["completeSimple()"],
			[`${AGENT}/config/model-roles`]: ["roleCandidatePool()"],
			[`${AGENT}/config/model-resolver`]: ["resolveRoleChain()"],
			[`${AGENT}/tiny/text`]: ["normalizeGeneratedTitle()", "isLowSignalTitleInput()"],
			[`${AGENT}/session/messages`]: ["operatorTitleText()", "buildReplanTitleContext()"],
			[`${AGENT}/utils/title-card`]: ["splitCardTitle()", "formatCardTitle()", "keepTitleCard()"],
			[`${AGENT}/utils/title-settings`]: ["cfgTitleIcons.get()"],
			[UTILS]: ["prompt.render()", "logger.info()"],
		},
		prompts: ["system/title-system.md"],
	},
	/**
	 * modes/judge-assist.ts: one switch (judge_assist_set) and three questions asked of stock's judge through one
	 * loader and one gate (available, needs_user, preview_check). One id: every stock call sits in the engine's `try`,
	 * so a missing internal already means "the judge did not decide" for that question alone, and this guard only
	 * names the judge when main asks it directly.
	 */
	judgeAssist: {
		session: ["settings", "sessionId", "modelRegistry", "sessionManager", "messages"],
		modules: {
			"@oh-my-pi/pi-ai": ["nativeJudgmentImageBounds()"],
			[`${AGENT}/judgment`]: [
				"hasNativeJudge()",
				"resolveJudge()",
				"sharedJudgmentCache()",
				"journalJudgmentUsage()",
			],
		},
	},
	/**
	 * modes/memory-recall.ts: the public `before_agent_start` hook (its `message` result) and the main session for the
	 * judge (judge-assist-engine.ts `recallRelevance`, whose stock imports `judgeAssist` lists; without them the code
	 * rule chooses).
	 */
	memoryRecall: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
		session: ["settings", "sessionId", "modelRegistry", "sessionManager"],
	},
	/**
	 * modes.auto_mode_decide and modes.auto_mode_prefetch: the prefetch asks the question the decision will ask, and
	 * the decision reads its answer from stock's judgment cache. `hasNativeJudge` is the judge warm-up's alone
	 * (`install`, at session start, nothing guards it): listed here, with the judge it warms.
	 */
	autoMode: {
		session: [
			"subscribe()",
			"settings",
			"sessionId",
			"model",
			"isStreaming",
			"messages",
			"getTodoPhases()",
			"getAsyncJobTree()",
			"modelRegistry",
			"agent.metadataForProvider()",
			"agent.telemetry",
			"sessionManager.getSessionId()",
			"getPlanModeState()",
			"getGoalModeState()",
		],
		modules: {
			[`${AGENT}/judgment`]: [
				"resolveJudge()",
				"sharedJudgmentCache()",
				"journalJudgmentUsage()",
				"hasNativeJudge()",
			],
			[`${AGENT}/tiny/message-preproc`]: ["preprocessTinyMessage()"],
			[`${AGENT}/plan-mode/settings`]: ["cfgPlanEnabled.get()"],
			[`${AGENT}/config/registry`]: ["lookup()"],
		},
	},
	/** modes.auto_mode_undo: leaves the plan mode an automatic decision entered (modes/plan.ts `exitPlanMode`). */
	autoModeUndo: union(PLAN_EXIT, { session: ["subscribe()", "getPlanModeState()"] }),
	/** compaction_points: where auto-compaction triggers for each model and each role's model, by stock's hub code. */
	compactionPoints: {
		session: ["settings", "getAvailableModels()", "modelRegistry.getAll()", "modelRegistry.getAvailable()"],
		modules: {
			[`${AGENT}/session/model-compaction-threshold`]: ["describeModelCompactionPoint()"],
			[`${AGENT}/modes/model-browser-source`]: ["createModelBrowserSource()"],
			[`${AGENT}/modes/view-model/overlays/model-browser`]: ["resolveRoleAssignments()"],
		},
	},
	/** compaction_limits: a typed limit checked and formatted by stock's own parser, before `settings_set` writes it. */
	compactionLimits: {
		modules: {
			[`${AGENT}/config/compaction-threshold`]: [
				"parseCompactionPointInput()",
				"validateModelCompactionThresholds()",
				"formatCompactionPointInput()",
			],
		},
	},
	/**
	 * idle-maintenance.ts: stock's documented idle scheduler (`enableIdleMaintenance`, omp://sdk.md › Idle maintenance,
	 * omp 18.13.2) on the live session; the bridge supplies the draft and shows the recap stock hands over, and wraps
	 * the session's `recordRecap` so a mojibake reply never reaches history.db.
	 */
	idleMaintenance: {
		session: [
			"enableIdleMaintenance()",
			"refreshIdleMaintenance()",
			"sendCustomMessage()",
			"sessionManager.recordRecap()",
		],
		modules: {
			[`${AGENT}/utils/render-utils`]: ["previewLine()", "TRUNCATE_LENGTHS"],
		},
	},
	/** prompt-origin.ts: a host tab journals its device per user message (public `message_end` hook). */
	promptOrigin: {
		session: ["sessionManager.appendCustomEntry()", "sessionManager.getEntries()"],
	},
	/** typed-prompts.ts: main's word on who typed, kept in the bridge's own store. Imports nothing from omp. */
	typedPrompts: {},
	/**
	 * answer-first.ts: whether the agent loop owns a turn when a queued batch is prepared. Its hooks are public
	 * (`before_agent_start` for the companion; `message_update`, `message_end`, `tool_call` and `agent_end` for the gate).
	 */
	answerFirst: {
		pkg: ["AgentRegistry.global()", "AgentRegistry.prototype.get()", "MAIN_AGENT_ID"],
		session: ["agent.state"],
	},
	/** context.inspect: every tool, skill, instruction file, prompt block and message, counted as stock counts them. */
	contextInspector: {
		session: [
			"getContextBreakdown()",
			"systemPrompt",
			// Where stock built each instruction file and skill into the prompt (omp 18.18.9).
			"systemPromptSources",
			// OMPdesk's sections read the session as a prompt's hook does (prompt-sections.ts `sectionContext`).
			"extensionRunner.createContext()",
			"hasBuiltInTool()",
			"getToolCommandEntries()|getXdevToolEntries()",
			"settings",
			"agent.state",
			"agent.tokenizer.countTokens()",
			"agent.tokenizer.countMessage()",
		],
		modules: {
			[`${AGENT}/session/messages`]: ["convertToLlm()"],
			[`${AGENT}/session/context-usage`]: ["estimateToolSchemaTokens()", "claimPromptSources()"],
		},
	},
	/** context.entry: one entry's text as the provider gets it (a tool's schema as stock serializes it). */
	contextEntry: {
		session: [
			"systemPrompt",
			"systemPromptSources",
			"extensionRunner.createContext()",
			"getToolCommandEntries()|getXdevToolEntries()",
			"agent.state",
		],
		modules: {
			[`${AGENT}/session/messages`]: ["convertToLlm()"],
			[`${AGENT}/session/context-usage`]: ["claimPromptSources()"],
			"@oh-my-pi/pi-ai/utils/schema": ["toolWireSchema()"],
		},
	},
	/** recent-models.ts: stock's most-recently-used model order, as the `/models` hub reads it. */
	recentModels: {
		session: ["settings", "settings.getStorage()"],
		modules: {
			[`${AGENT}/modes/model-browser-source`]: ["createModelBrowserSource()"],
			[`${AGENT}/session/agent-storage`]: ["AgentStorage.prototype.getModelUsageOrder()"],
		},
	},
	/** model-choice.ts: the session's own model while a retry fallback (or another temporary switch) runs it. */
	modelChoice: {
		session: [
			"model",
			"modelRegistry",
			"sessionManager.getLastModelChangeRole()",
			"sessionManager.getLeafId()",
			"sessionManager.buildSessionContext()",
		],
		modules: {
			[`${AGENT}/session/session-context`]: ["getRestorableSessionModels()"],
			[`${AGENT}/config/model-resolver`]: ["resolveSessionModelSelector()"],
		},
	},
	accountPools: {
		// provider_accounts (settings.ts): each account's token-free identity key, the
		// string `task.agentAccountPools` matches.
		modules: {
			"@oh-my-pi/pi-ai": ["resolveCredentialIdentityKey()"],
		},
	},
	/** git.worktree_location: naming and authorization by the running omp's `worktree.base` and its path hash. */
	worktreeLocation: { modules: { [UTILS]: ["getWorktreesDir()", "hashPath()"] } },
	/** git.pr_checkout: stock's own checkout of a pull request into a worktree. */
	prCheckout: {
		session: ["settings", "sessionManager.getCwd()", "sessionManager.getSessionFile()"],
		modules: { [`${AGENT}/tools/gh-pr-checkout`]: ["checkoutPullRequest()"] },
	},
	/**
	 * worktree_lifecycle_settings and worktree_lifecycle_create (worktree-lifecycle.ts): main reads the
	 * `worktree.onStart` / `worktree.onExit` policies and stock's start condition, then has stock create the worktree.
	 * One id: a policy whose worktree cannot be made is not read, so the tab starts where it is instead of asking the
	 * person and then failing.
	 */
	worktreeLifecycle: {
		session: ["settings", "sessionManager.getCwd()"],
		modules: {
			[`${AGENT}/task/settings`]: ["cfgWorktreeOnStart.get()", "cfgWorktreeOnExit.get()"],
			[`${AGENT}/session/session-worktree`]: [
				"canAutoCreateWorktree()",
				"createSessionWorktree()",
				"defaultSessionWorktreeBranch()",
			],
			[UTILS]: ["getWorktreesDir()"],
		},
	},
	/**
	 * No bridge method uses these: stock-helper/worktrees.ts reads the worktree location without a session
	 * (`worktree.base` read-only, applied as stock's effect does) for a worktree a paired device's agent makes here.
	 */
	worktreeBase: {
		modules: {
			[`${AGENT}/task/settings`]: ["cfgWorktreeBase.get()"],
			[`${AGENT}/config/settings`]: ["Settings.loadReadOnly()"],
			[UTILS]: ["getWorktreesDir()", "hashPath()", "setWorktreesDir()"],
		},
	},
	resetPasses: {
		// reset-passes.ts (redeem) + the passes on usage / provider_accounts (settings.ts):
		// stock's `/usage reset` helpers and redeem. A confirmed pass stock does not spend (Claude names another next,
		// or its offer read failed) is spent with stock's offer read and claim over the stored account's access.
		session: [
			"redeemResetCredit()",
			"modelRegistry.authStorage.oauth.accessById()",
			"modelRegistry.authStorage.usage.invalidate()",
		],
		modules: {
			"@oh-my-pi/pi-ai": ["listClaudeResetCredits()", "consumeClaudeResetCredit()"],
			"@oh-my-pi/pi-ai/oauth": ["getOAuthCredentialProvider()"],
			[`${AGENT}/slash-commands/helpers/reset-usage`]: ["toResetUsageAccounts()", "describeRedeemOutcome()"],
		},
	},
	phoneImages: {
		// stock-helper/images.ts `image.toModel`: a phone's HEIC/HEIF made model-safe with stock's image path.
		session: [],
		modules: {
			[`${AGENT}/utils/image-input`]: ["ensureSupportedImageInput()"],
			[`${AGENT}/utils/image-resize`]: ["resizeImage()"],
		},
	},
	sessionOwner: {
		// stock-helper/sessions.ts `sessions.owned` (main's session-free.ts): whether another live omp holds a stored
		// session's ownership lease, keyed by the header's id read past the title slot as stock does.
		session: [],
		modules: {
			[`${AGENT}/session/session-storage`]: ["tryAcquireSessionLease()"],
			[`${AGENT}/session/session-title-slot`]: ["parseTitleSlotFromContent()"],
		},
	},
	/**
	 * ask-form.ts: `formDialog` defined on the session's RPC UI context (`extensionRunner.getUIContext()`), asking a form
	 * through the context's own `askDialog`; the form's parse, questions, values and checks are stock's html-form helpers,
	 * and duplicate option labels are told apart as stock's field-by-field walk does.
	 */
	askForm: {
		session: ["extensionRunner.hasUI()", "extensionRunner.getUIContext()"],
		modules: {
			[`${AGENT}/tools/html-form/parse`]: ["parseHtmlForm()", "spansText()"],
			[`${AGENT}/tools/html-form/data`]: [
				"fieldQuestions()",
				"choiceValue()",
				"textValue()",
				"fieldError()",
				"defaultFormData()",
			],
			[`${AGENT}/utils/render-utils`]: ["disambiguateDisplayLabels()"],
		},
	},
	/** image-subscription.ts: the public `tool_call` hook (`input`, `block`) only. Imports nothing from omp. */
	imageSubscription: {},
};

export const ALL_FEATURES = Object.keys(FEATURES) as FeatureId[];

/** Whether `path` resolves on `root` (see the module comment for the path syntax). Throwing getters count as missing. */
export function hasPath(root: unknown, path: string): boolean {
	const callable = path.endsWith("()");
	const segments = (callable ? path.slice(0, -2) : path).split(".");
	const last = segments.pop() ?? "";
	const isObjectLike = (value: unknown): value is object =>
		(typeof value === "object" && value !== null) || typeof value === "function";
	try {
		let owner: unknown = root;
		for (const segment of segments) {
			if (!isObjectLike(owner)) return false;
			owner = (owner as Record<string, unknown>)[segment];
		}
		if (!isObjectLike(owner)) return false;
		return callable ? typeof (owner as Record<string, unknown>)[last] === "function" : last in owner;
	} catch {
		return false;
	}
}

/** omp's scheme for a bridge import it serves from the running omp's own bundle (`extensibility/plugins/legacy-pi-compat.ts`). */
export const BUNDLED_SCHEME = "omp-legacy-pi-bundled:";

/**
 * Stock modules the bridge may load as a separate copy, each with why that is harmless.
 *
 * omp rewrites a bridge's `@oh-my-pi/*` import onto the running omp's module only when its bundle registers that
 * subpath; any other subpath falls back to the package's source file, a second module graph with its own settings
 * registry, settings singleton and module state. A copy's setting handles read other settings' slots of the live
 * session (`goal.enabled` read `[]` on omp 18.12.2), so a copy is allowed only when it reads no setting and the
 * bridge needs none of its state shared with the session. Anything else goes through a bundled module (the registry's
 * `lookup`, a package root, a stock tool), and a new copy fails bridge-stock-settings-stock.test.ts.
 */
export const COPY_SAFE: Readonly<Record<string, string>> = {
	"@oh-my-pi/pi-ai/auth/blocks": "block-scope constants and key helpers: no setting, no state",
	"@oh-my-pi/pi-ai/auth/rank": "the usage-ranking comparator: pure, imports nothing",
	"@oh-my-pi/pi-ai/auth/usage-report": "usage-window arithmetic: pure",
	[`${AGENT}/autolearn/managed-skills`]:
		"only the provider id and the name sanitizer (pure); writes go through stock's `manage_skill` tool, never the copy's own per-skill mutation chain",
	[`${AGENT}/config`]:
		"the `.omp` config dirs only: the copy's provider switches are unbound defaults and `.omp` is never a switchable foreign provider",
	[`${AGENT}/sdk`]: "presence probe only: the stock helper loads it from omp's package in its own process",
	[`${AGENT}/security/store`]: "scan files on disk under stock's file lock: no setting",
	[`${AGENT}/skillshare/client`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/skillshare/installer`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/skillshare/manifest`]: "presence probe only: the stock helper loads it in its own process",
	[`${AGENT}/tiny/message-preproc`]: "text cleanup: pure",
	[`${AGENT}/tiny/text`]: "title text helpers: pure",
	[`${AGENT}/tts/models`]: "the local voice and model tables: data",
	[`${AGENT}/tts/tts-client`]:
		"NOT harmless, kept for want of a route: omp's bundle has no `tts/*` at all and only stock's `tts` tool reaches its client, falling through to cloud voices the speech role lists (read-aloud stays local). The copy runs its own worker and, uninitialised, takes the tiny-model device and dtype from the environment instead of `providers.tinyModel*` (needs `tts/*` in omp's bundle upstream)",
	[`${AGENT}/tts/wav`]: "the WAV encoder: pure",
	[`${AGENT}/ui/overlays/settings/pages`]:
		"the settings tabs' labels: constant data importing nothing at run time; omp's bundle registers no `ui/*` module",
};

/**
 * Source copies whose first import makes bun transpile a large part of omp's source tree inside the omp process,
 * measured on Windows (omp 18.12.3, bun 1.4.3, warm cache): `config` and `tts/*` ~540 ms of omp's only thread, `sdk` and
 * `skillshare/*` another ~600 ms; with a cold transpiler cache the same loads took 4 to 6 s before omp's `ready`. The
 * startup `capabilities` probe leaves them unevaluated (`ProbeSources.unloaded`); `guard` still evaluates a feature's
 * modules on its first call, except the `PRESENCE_ONLY` ones. Each is in COPY_SAFE.
 */
export const HEAVY_COPIES: Readonly<Record<string, string>> = {
	[`${AGENT}/config`]: "extensions/agents.ts loads it on use",
	[`${AGENT}/sdk`]: "presence probe only",
	[`${AGENT}/skillshare/client`]: "presence probe only",
	[`${AGENT}/skillshare/installer`]: "presence probe only",
	[`${AGENT}/skillshare/manifest`]: "presence probe only",
	[`${AGENT}/tts/models`]: "voice.ts loads it on use",
	[`${AGENT}/tts/tts-client`]: "voice.ts loads it on use",
	[`${AGENT}/tts/wav`]: "voice.ts loads it on use",
};

/**
 * HEAVY_COPIES no bridge module imports: the stock helper loads each from omp's package in its own process, and the
 * bridge only names it in REQUIREMENTS. Every probe, `guard` included, checks only that its file is there and never
 * evaluates it in omp: `providers`' first guarded call evaluated `sdk`, ~1.1 s of omp's only thread right after a
 * tab's `ready` (measured on macOS, omp 18.13.1), while the window asks it at once, so every request of the tab,
 * prompts included, waited behind it. Their exports are checked where they run (the helper refuses an omp without
 * them, `stock-helper/accounts.ts`).
 */
export const PRESENCE_ONLY: Readonly<Record<string, true>> = {
	[`${AGENT}/sdk`]: true,
	[`${AGENT}/skillshare/client`]: true,
	[`${AGENT}/skillshare/installer`]: true,
	[`${AGENT}/skillshare/manifest`]: true,
};

/**
 * Specifiers whose loader reached a separate copy, from each loader's import target as omp rewrote it. On an omp run
 * from source nothing is bundled and every import shares one graph, so nothing counts as a copy there.
 */
export function separateCopies(targets: Readonly<Record<string, string>>): string[] {
	const entries = Object.entries(targets);
	if (!entries.some(([, target]) => target.startsWith(BUNDLED_SCHEME))) return [];
	return entries.filter(([, target]) => !target.startsWith(BUNDLED_SCHEME)).map(([specifier]) => specifier);
}

/** The copies a probe refuses: every separate copy not in COPY_SAFE. */
export function unsafeCopies(targets: Readonly<Record<string, string>>): Set<string> {
	return new Set(separateCopies(targets).filter(specifier => !(specifier in COPY_SAFE)));
}

/** What a probe reads; fakes in tests, live omp objects in health.ts. */
export interface ProbeSources {
	/** The live AgentSession; `undefined` skips session requirements (none attached yet). */
	session: unknown;
	/** omp's package index (`env.pi.pi`). */
	pkg: unknown;
	/** The bridge's own ExtensionAPI instance (`env.pi`). */
	api: unknown;
	/** Imported module namespaces by specifier; an absent key means the import failed. */
	modules: ReadonlyMap<string, unknown>;
	hasPrompt(relative: string): boolean;
	/** Labels reported missing even when present (`OMP_GUI_BRIDGE_PROBE_HIDE`). */
	hidden?: ReadonlySet<string>;
	/** Specifiers that loaded a separate copy of stock, not the running omp's module (`unsafeCopies`). */
	copies?: ReadonlySet<string>;
	/**
	 * Specifiers a probe left unevaluated because their file is there and loading it is costly (`HEAVY_COPIES`): present
	 * for this check, verified by the first guarded call that needs them (`PRESENCE_ONLY` ones never are).
	 */
	unloaded?: ReadonlySet<string>;
}

const label = (owner: string, path: string) => `${owner}${path.endsWith("()") ? path.slice(0, -2) : path}`;

/**
 * Missing labels for one requirement: `AgentSession.x`, `pi.x`, `ExtensionAPI.x`, `<specifier>#x`, `<specifier>`,
 * `prompts/<file>`.
 */
export function missingFor(requirement: FeatureRequirement, sources: ProbeSources): string[] {
	const missing: string[] = [];
	const check = (present: boolean, name: string) => {
		if (!present || sources.hidden?.has(name)) missing.push(name);
	};
	const member = (root: unknown, owner: string, path: string) => {
		if (!path.includes("|")) return check(hasPath(root, path), label(owner, path));
		const names = path.split("|");
		if (!names.some(name => hasPath(root, name) && !sources.hidden?.has(label(owner, name)))) {
			missing.push(names.map(name => label(owner, name)).join(" or "));
		}
	};
	if (sources.session !== undefined) {
		for (const path of requirement.session ?? []) {
			member(sources.session, "AgentSession.", path);
		}
	}
	for (const path of requirement.pkg ?? []) check(hasPath(sources.pkg, path), label("pi.", path));
	for (const path of requirement.api ?? []) check(hasPath(sources.api, path), label("ExtensionAPI.", path));
	for (const [specifier, paths] of Object.entries(requirement.modules ?? {})) {
		if (sources.copies?.has(specifier)) {
			missing.push(`${specifier} (separate copy, not this omp's module)`);
			continue;
		}
		if (sources.unloaded?.has(specifier)) continue;
		if (!sources.modules.has(specifier)) {
			missing.push(specifier);
			continue;
		}
		const namespace = sources.modules.get(specifier);
		for (const path of paths) member(namespace, `${specifier}#`, path);
	}
	for (const prompt of requirement.prompts ?? []) check(sources.hasPrompt(prompt), `prompts/${prompt}`);
	return missing;
}

/** One unavailable entry, marked `core` when a core flow needs the feature. */
function unavailableEntry(feature: FeatureId, missing: string[]): UnavailableFeature {
	return Object.hasOwn(CORE_FEATURES, feature) ? { feature, missing, core: true } : { feature, missing };
}

/** Features (in `features` order) with at least one missing requirement. */
export function deriveUnavailable(
	features: readonly FeatureId[],
	sources: ProbeSources,
	requirements: Readonly<Partial<Record<FeatureId, FeatureRequirement>>> = REQUIREMENTS,
): UnavailableFeature[] {
	const unavailable: UnavailableFeature[] = [];
	for (const feature of features) {
		const requirement = requirements[feature];
		if (!requirement) continue;
		const missing = missingFor(requirement, sources);
		if (missing.length > 0) unavailable.push(unavailableEntry(feature, missing));
	}
	return unavailable;
}

/** A bridge module (index.ts `AREAS`) whose import threw, e.g. a removed static export. */
export interface AreaFailure {
	area: string;
	features: readonly FeatureId[];
	error: string;
}

/** Every feature a failed module serves is unavailable, whatever the probe saw. */
export function mergeAreaFailures(
	unavailable: readonly UnavailableFeature[],
	failures: readonly AreaFailure[],
): UnavailableFeature[] {
	const merged = new Map<FeatureId, string[]>(unavailable.map(entry => [entry.feature, [...entry.missing]]));
	for (const failure of failures) {
		const note = `gui-bridge/${failure.area}.ts failed to load: ${failure.error}`;
		for (const feature of failure.features) {
			const missing = merged.get(feature) ?? [];
			if (!missing.includes(note)) missing.push(note);
			merged.set(feature, missing);
		}
	}
	return [...merged].map(([feature, missing]) => unavailableEntry(feature, missing));
}

/** `OMP_GUI_BRIDGE_PROBE_HIDE`: comma-separated missing labels to simulate (diagnostics and tests). */
export function parseHidden(raw: string | undefined): ReadonlySet<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map(entry => entry.trim())
			.filter(Boolean),
	);
}

/** Thrown where a missing omp internal is hit; index.ts forwards `code` to the GUI. */
export class UnsupportedOmpError extends Error {
	readonly code = "unsupported_omp";
	readonly unavailable: readonly UnavailableFeature[];

	constructor(unavailable: readonly UnavailableFeature[], ompVersion?: string) {
		const parts = unavailable.map(entry => `${FEATURES[entry.feature]} (missing ${entry.missing.join(", ")})`);
		super(
			`Unavailable with ${ompVersion ? `omp ${ompVersion}` : "this omp"}: ${parts.join("; ")}. ` +
				"OMPdesk updates omp by itself; report an issue if it persists.",
		);
		this.name = "UnsupportedOmpError";
		this.unavailable = unavailable;
	}
}

/** Fail with `unsupported_omp` unless `owner.<path>` is a function (`ownerLabel` names `owner` in the error). */
export function requireFn(owner: unknown, path: string, feature: FeatureId, ownerLabel = "AgentSession"): void {
	if (!hasPath(owner, `${path}()`)) throw new UnsupportedOmpError([{ feature, missing: [`${ownerLabel}.${path}`] }]);
}
