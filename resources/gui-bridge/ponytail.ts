import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createMarketplaceManager } from "./extensions/shared";
import { getProviderInfo, registerProvider } from "./omp/pi-coding-agent/capability";
import { scanSkillsFromDir } from "./omp/pi-coding-agent/discovery/helpers";
import { parseFrontmatter } from "./omp/pi-utils";
import { type JournalEntry, registerPromptSection } from "./prompt-sections";

const providerId = "ompdesk-ponytail";
const dir = fileURLToPath(new URL("../omp-builtin/ponytail/skills", import.meta.url));
const skillFile = join(dir, "ponytail", "SKILL.md");
const modeEntry = "ponytail-mode";
type Level = "lite" | "full" | "ultra" | "off";

function isLevel(value: unknown): value is Level {
	return value === "lite" || value === "full" || value === "ultra" || value === "off";
}

function sessionMode(entries: readonly JournalEntry[]): Level | "review" {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== modeEntry) continue;
		const data = entry.data;
		if (typeof data !== "object" || !data || !("mode" in data)) continue;
		if (isLevel(data.mode) || data.mode === "review") return data.mode;
	}
	return "full";
}

const instructions = new Map<string, string>();
function modeInstructions(mode: Exclude<Level, "off"> | "review"): string {
	let text = instructions.get(mode);
	if (!text) {
		const file = mode === "review" ? join(dir, "ponytail-review", "SKILL.md") : skillFile;
		const { body } = parseFrontmatter(readFileSync(file, "utf8"), { source: file });
		text = `PONYTAIL MODE ACTIVE — level: ${mode}\n\n${body.trim()}`;
		instructions.set(mode, text);
	}
	return text;
}

const bundledSessions = new WeakMap<object, ExtensionAPI>();
function hasBundledSkill(pi: ExtensionAPI): boolean {
	return pi.getCommands().some(command => command.name === "skill:ponytail" && command.path === skillFile);
}

export default function ponytail(pi: ExtensionAPI): void {
	let bound = false;
	pi.on("session_start", (_event, ctx) => {
		// Discovery already resolved plugin ownership, disabled skills and name collisions for this session.
		if (!hasBundledSkill(pi)) return;
		bundledSessions.set(ctx.sessionManager, pi);
		if (bound) return;
		bound = true;
		pi.registerCommand("ponytail", {
			description: "Set this session's Ponytail level: lite, full, ultra or off.",
			handler: async (args, ctx) => {
				if (!hasBundledSkill(pi)) {
					ctx.ui.notify("The bundled Ponytail skill is disabled.", "info");
					return;
				}
				const arg = args.trim().toLowerCase();
				const current = sessionMode(ctx.sessionManager.getBranch());
				const level = !arg && current === "off" ? "full" : arg;
				if (isLevel(level)) {
					pi.appendEntry(modeEntry, { mode: level });
					ctx.ui.notify(`Ponytail mode set to ${level}.`, "info");
				} else if (!arg || arg === "status") {
					ctx.ui.notify(`Ponytail: current ${current} • default full`, "info");
				} else {
					ctx.ui.notify("Use /ponytail lite, full, ultra or off.", "warning");
				}
			},
		});
		pi.on("input", (event, ctx) => {
			if (event.source === "extension") return;
			if (!/^(?:stop ponytail|normal mode)[.!?\s]*$/i.test(event.text.trim()) || !hasBundledSkill(pi)) return;
			if (sessionMode(ctx.sessionManager.getBranch()) !== "off") pi.appendEntry(modeEntry, { mode: "off" });
		});
		registerPromptSection(pi, "ponytail", ctx => {
			const host = bundledSessions.get(ctx.sessionManager);
			if (!host || !hasBundledSkill(host)) return undefined;
			const mode = sessionMode(ctx.sessionManager.getBranch());
			return mode === "off" ? undefined : modeInstructions(mode);
		});
	});
	// Stock rebinds extension factories for subagents, but its discovery providers belong to the process.
	if (getProviderInfo(providerId)) return;
	registerProvider("skills", {
		id: providerId,
		displayName: "OMPdesk Ponytail",
		description: "Bundled Ponytail skills",
		priority: 0,
		async load(ctx) {
			const manager = await createMarketplaceManager(ctx.cwd);
			// Even a disabled install owns the choice. Different versions otherwise survive as namespaced aliases.
			const installed = await manager.listInstalledPlugins();
			if (installed.some(plugin => plugin.id === "ponytail@ponytail" && plugin.entries.length > 0))
				return { items: [] };
			return scanSkillsFromDir(ctx, { dir, providerId, level: "user", requireDescription: true });
		},
	});
}
