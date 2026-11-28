/**
 * Writes THIRD_PARTY_NOTICES.txt: the license and copyright text of every third-party
 * component the packaged app ships. `--check` fails when the checked-in file is stale
 * (`bun run licenses:check`); `bun run gen:licenses` rewrites it.
 *
 * What ships: electron-builder packs `out/**` and no node_modules, so a package is in
 * the app when main, preload or the renderer bundle it. The shipped set is taken as the
 * production closure of package.json `dependencies` (plus `optionalDependencies` that
 * are installed), read from node_modules. The engine (CEF and Chromium), Node and the shell's crates are sections
 * 2 and 5; no Electron ships. This is a superset of
 * what Rollup tree-shook into `out/`, never a subset. The few devDependencies the
 * bundles import are type-only (unified, remark-parse, micromark-*), so none are added.
 * A package built for some platforms only (its package.json names `os` or `cpu`: a
 * prebuilt native addon such as `@napi-rs/canvas-win32-x64-msvc`) is left out: no bundle
 * can carry a `.node` file, and which one is installed depends on the machine, so the
 * file would differ between the computers that check it.
 *
 * Dependency-free and deterministic: sorted names, no dates, LF line endings.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import aiMemorySource from "../native/memory/ompdesk.json" with { type: "json" };
import cefPin from "../native/ompdesk/crates/shell/cef-pin.json" with { type: "json" };
import interfacesPin from "../resources/omp-builtin/interfaces/interfaces-config.json" with { type: "json" };
import ponytailPin from "../resources/omp-builtin/ponytail/ponytail-config.json" with { type: "json" };
import agentDesktopPin from "./agent-desktop-pin.json" with { type: "json" };
import { committedCrateList } from "./gen-crate-notices";
import nodePin from "./node-runtime-pin.json" with { type: "json" };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "THIRD_PARTY_NOTICES.txt");

interface PackageJson {
	name: string;
	version: string;
	license?: string | { type?: string };
	licenses?: { type?: string }[];
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	os?: string[];
	cpu?: string[];
}

interface Component {
	name: string;
	version: string;
	spdx: string;
	text: string;
	dir: string;
}

/** SPDX ids (or `OR` alternatives containing one) that may be distributed inside an Apache-2.0 product. MPL-2.0 is weak copyleft: allowed, reported in the audit. */
const PERMISSIVE = new Set([
	"MIT",
	"MIT-0",
	"ISC",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"0BSD",
	"Apache-2.0",
	"BlueOak-1.0.0",
	"MPL-2.0",
	"Unlicense",
	"CC0-1.0",
	"Python-2.0",
	"OFL-1.1",
	"Zlib",
	"CC-BY-4.0",
	"WTFPL",
]);

const LICENSE_FILE = /^(licen[sc]e|copying|notice)(\.|-|$)/i;

function readJson(file: string): PackageJson {
	return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

/** Node resolution of a package directory: `from/node_modules/<name>`, then each parent's. */
function findPackageDir(name: string, from: string): string | undefined {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function declaredLicense(pkg: PackageJson): string {
	if (typeof pkg.license === "string") return pkg.license;
	if (pkg.license?.type) return pkg.license.type;
	const legacy = pkg.licenses?.map(entry => entry.type).filter(Boolean);
	if (legacy?.length) return legacy.join(" OR ");
	return "UNKNOWN";
}

/** The package's license and notice files, in name order, joined; empty when it has none. */
function licenseText(dir: string): string {
	const files = readdirSync(dir)
		.filter(name => LICENSE_FILE.test(name))
		.sort();
	const parts: string[] = [];
	for (const name of files) {
		const full = join(dir, name);
		try {
			parts.push(readFileSync(full, "utf8").replace(/\r\n?/g, "\n").trim());
		} catch {
			// A directory such as `licenses/`: not a file text.
		}
	}
	return parts.filter(Boolean).join("\n\n");
}

function collect(): { components: Component[]; missing: string[] } {
	const rootPkg = readJson(join(ROOT, "package.json"));
	const seen = new Map<string, Component>();
	const missing: string[] = [];

	const visit = (name: string, from: string, optional: boolean): void => {
		const dir = findPackageDir(name, from);
		if (!dir) {
			if (!optional) missing.push(name);
			return;
		}
		const pkg = readJson(join(dir, "package.json"));
		if (pkg.os || pkg.cpu) return;
		const key = `${pkg.name}@${pkg.version}`;
		if (seen.has(key)) return;
		seen.set(key, {
			name: pkg.name,
			version: pkg.version,
			spdx: declaredLicense(pkg),
			text: licenseText(dir),
			dir: dir.slice(ROOT.length + 1),
		});
		for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir, false);
		for (const dep of Object.keys(pkg.optionalDependencies ?? {})) visit(dep, dir, true);
	};

	for (const dep of Object.keys(rootPkg.dependencies ?? {})) visit(dep, ROOT, false);
	for (const dep of Object.keys(rootPkg.optionalDependencies ?? {})) visit(dep, ROOT, true);
	const components = [...seen.values()].sort((a, b) =>
		a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
	);
	return { components, missing };
}

/** First line that states a copyright, to head a group with. */
function copyrightLines(text: string): string[] {
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => /copyright|\(c\)|©/i.test(line) && line.length < 200);
}

function isPermissive(spdx: string): boolean {
	const ids = spdx
		.replace(/[()]/g, " ")
		.split(/\s+(?:OR|AND)\s+/)
		.map(id => id.trim());
	return ids.some(id => PERMISSIVE.has(id));
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

/** The MIT License's terms, shared by the palettes credited above their copyright lines. */
const MIT_TEXT = [
	"Permission is hereby granted, free of charge, to any person obtaining a copy of the palettes",
	'and associated documentation files (the "Software"), to deal in the Software without',
	"restriction, including without limitation the rights to use, copy, modify, merge, publish,",
	"distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the",
	"Software is furnished to do so, subject to the following conditions:",
	"",
	"The above copyright notice and this permission notice shall be included in all copies or",
	"substantial portions of the Software.",
	"",
	'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING',
	"BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND",
	"NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,",
	"DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
	"OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
].join("\n");

function vendoredSections(): string {
	const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n?/g, "\n").trim();
	const aiMemoryLicense = read("LICENSES/ai-memory-LICENSE");
	const pstackLicense = read("LICENSES/MIT-pstack.txt");
	const eccLicense = read("LICENSES/MIT-ecc.txt");
	const proofLicense = read("LICENSES/proof-skills-MIT.txt");
	const eccPin = JSON.parse(read("resources/omp-builtin/ecc/ecc-config.json")) as {
		commit: string;
		version: string;
	};
	const pstackPin = JSON.parse(read("resources/omp-builtin/pstack/pstack-config.json")) as {
		commit: string;
		version: string;
	};
	const lobeLicense = read("LICENSES/MIT-lobe-icons.txt");
	const cefLicense = read("LICENSES/CEF-LICENSE.txt");
	return [
		[
			"Mixdog (https://github.com/tribgames/mixdog)",
			"Copyright (c) 2026 tribgames. Licensed under the Apache License, Version 2.0 (full text:",
			"LICENSES/Apache-2.0.txt, shipped beside this file). The adapted parts were modified for",
			"OMPdesk. Source revision read: c088221d889a9ca2d8a3366b878df97604de5f5e.",
			"",
			"Ported files (OMPdesk file <- Mixdog file, both relative to their repo root):",
			"",
			"- src/renderer/lib/markdown-paths.ts",
			"  <- apps/desktop/src/renderer/markdown-plugins.ts (path mention grammar:",
			"     prose/inline-code path patterns, trailing line references, known file",
			"     names and extensions)",
			"- src/renderer/lib/remark-cjk.ts",
			"  <- apps/desktop/src/renderer/markdown-plugins.ts",
			"     (repairAdjacentStrongPunctuation, trimAutolinkCjkSuffix)",
		].join("\n"),
		[
			"A2UI (https://github.com/a2ui-project/a2ui)",
			"Copyright 2025 Google LLC. Licensed under the Apache License, Version 2.0 (full text:",
			"LICENSES/Apache-2.0.txt, shipped beside this file). The npm package @a2ui/web_core is listed in",
			"section 3; the files below are derived from the A2UI specification and are modified by SeuPut.",
			"",
			"- resources/gui-bridge/modes/a2ui-catalog.json",
			"  <- catalogs/basic/v1/catalog.json (no Video or AudioPlayer, Image.url a literal string,",
			"     TextField without the obscured variant, a Chart component added)",
			"- resources/gui-bridge/modes/a2ui-schema.json",
			"  <- specification/v1_0/json/agent_to_renderer.json and common_types.json, merged with the",
			"     catalog into one schema by scripts/gen-a2ui-schema.ts",
			"- src/main/fixtures/a2ui-spec-cases.json",
			"  <- specification/v1_0/test/cases/*.json (used as test fixtures only; not shipped)",
			"",
			'"A2UI" names the protocol only; its use implies no endorsement by Google LLC.',
		].join("\n"),
		[
			"momobot",
			"A bot's drawn face, its spring rig and its acting are adapted from momobot, licensed under the MIT",
			"License (full text below and in LICENSES/MIT-momobot.txt). The adapted parts were modified for",
			"OMPdesk. Source revision read: d4558504f6bcb5567db2204423f999c3b9550ea1.",
			"",
			"Ported files (OMPdesk file <- momobot file, both relative to their repo root):",
			"",
			"- src/renderer/lib/bot-face.ts <- app/src/lib/agents/bot-face.ts",
			"- src/renderer/lib/bot-face-rig.ts <- app/src/lib/agents/avatar-rig.ts",
			"- src/renderer/lib/bot-face-acting.ts <- app/src/lib/agents/avatar-acting.ts",
			"- src/renderer/lib/bot-face-motion.ts <- app/src/lib/agents/avatar-motion.ts",
			"- src/renderer/components/common/BotFace.tsx",
			"  <- app/src/components/agents/bot-face.tsx, app/src/components/agents/abstract-avatar.tsx",
			"",
			read("LICENSES/MIT-momobot.txt"),
		].join("\n"),
		[
			`ai-memory ${aiMemorySource.version} (https://github.com/akitaonrails/ai-memory, tag ${aiMemorySource.upstreamTag})`,
			"The source (vendored in native/memory/, with OMPdesk's changes) is built by OMPdesk into the binary",
			"(ai-memory / ai-memory.exe) that ships inside the app under resources/ai-memory-bin/ as its memory.",
			"Licensed under the MIT License (full text below, in LICENSES/ai-memory-LICENSE and in",
			"native/memory/LICENSE). The binary statically links the Rust crates listed in section 3, each under",
			"its own license.",
			"",
			aiMemoryLicense,
		].join("\n"),
		[
			"OMPdesk's own native binaries (native/ompdesk)",
			"OMPdesk's own Rust source is built into the binaries that ship inside the app under ompdesk-bin/ (ompdesk /",
			"ompdesk.exe, the command-line tool). They are OMPdesk's, under the Apache License, Version 2.0 (LICENSE), and",
			"statically link the Rust crates listed in section 4, each under its own license.",
		].join("\n"),
		[
			`Chromium Embedded Framework ${cefPin.cefVersion} (https://bitbucket.org/chromiumembedded/cef) and Chromium ${cefPin.chromium}`,
			"The app's browser engine: the release archive `native/ompdesk/crates/shell/cef-pin.json` pins (libcef and its",
			"runtime files, unmodified) ships beside the app's executable on Windows (libcef.dll, chrome_elf.dll and the",
			"rest) and as Chromium Embedded Framework.framework on macOS. CEF is licensed under the BSD 3-Clause License",
			"(full text below, in LICENSES/CEF-LICENSE.txt and shipped as LICENSE.cef.txt). Chromium and the libraries it",
			"bundles are under their own licenses, listed in LICENSES.chromium.html (CEF's CREDITS.html), which ships",
			"beside this file.",
			"",
			cefLicense,
		].join("\n"),
		[
			`Node.js ${nodePin.version} (https://nodejs.org)`,
			"The unmodified release binary (scripts/node-runtime-pin.json: nodejs.org's archive, checked against its",
			"published SHA-256) ships as node/node (node/node.exe on Windows) and runs the app's TypeScript main. Node.js is",
			"under the MIT License, with the licenses of the libraries it bundles (V8, OpenSSL, ICU, zlib, undici and",
			"others); Node's complete LICENSE file ships beside the binary as node/LICENSE.",
		].join("\n"),
		[
			"OMPdesk's CEF shell (native/ompdesk/crates/shell)",
			"OMPdesk's own Rust source is built into the shell that ships as the app's executable (OMPdesk.exe,",
			"OMPdesk.app/Contents/MacOS/OMPdesk and the helper apps copied from it). It is OMPdesk's, under the Apache",
			"License, Version 2.0 (LICENSE), and statically links the Rust crates listed in section 5, each under its own",
			"license.",
		].join("\n"),
		[
			`agent-desktop ${agentDesktopPin.version} (https://github.com/${agentDesktopPin.repo}, tag v${agentDesktopPin.version})`,
			"The upstream release binaries (agent-desktop and agent-desktop-macos-helper on macOS, agent-desktop.exe",
			"on Windows) ship unmodified inside the app under agent-desktop-bin/, unpacked from the release archive",
			"scripts/agent-desktop-pin.json pins by scripts/build-agent-desktop.ts; on macOS they are re-signed with",
			"the app. Licensed under the Apache License, Version 2.0 (full text: LICENSES/agent-desktop-LICENSE,",
			"also shipped as agent-desktop-bin/LICENSE). Upstream publishes no NOTICE file.",
		].join("\n"),
		[
			"pstack engineering skills (https://github.com/cursor/plugins/tree/main/pstack)",
			`Copyright (c) 2026 Lauren Tan, licensed under the MIT License. Skills, playbooks and agent text copied from`,
			`pstack ${pstackPin.version} (cursor/plugins commit ${pstackPin.commit}) into resources/omp-builtin/pstack/ by`,
			"scripts/sync-pstack.ts. Changes: Cursor and Claude tool, agent and model names are replaced by omp and",
			"OMPdesk ones, tdd and teach are renamed pstack-tdd and pstack-teach, and the Cursor-only parts (setup-pstack,",
			"poteto-help, make-bot-ui, Bugbot triage, the orchestrate playbook, the watch-pr and orch tools) are left out;",
			"the three formal-verification skills (create-/maintain-formal-verification-skill, statechart) are folded into",
			"the ompdesk-formal-verify skill.",
			"OMPdesk maintains the translated why and reflect skills and playbook descriptions from pstack 0.15.36",
			"(cursor/plugins commit c742dd61706fbacc1b95f1a20b7b988cf096ce6c) under the same MIT license.",
			"The license text is also in resources/omp-builtin/pstack/UPSTREAM-LICENSE.",
			"",
			pstackLicense,
		].join("\n"),
		[
			"proof-skills (https://github.com/opum-ai/proof-skills)",
			"Copyright (c) 2026 Opum AI, licensed under the MIT License. Its formal-verification skills (formal-verify,",
			"tlaplus-model, lean-model, proof-simplify: workflows, references, TLA+ patterns, Lean patterns and template,",
			"the findings schema, the correspondence template) are adapted into the built-in ompdesk-formal-verify skill",
			"under resources/omp-builtin/formal/. Changes: Claude Code paths, the Artifact tool and the bash and python",
			"scripts are replaced by OMPdesk and omp equivalents and by Bun TypeScript scripts written for OMPdesk (the",
			"TLC runner and trace reducer, the Lean trust audit, the mutation runner, the report renderer and the",
			"verify-all runner are new code); the `src:` tags became `@code` tags; the Lean patterns build without",
			"plausible on the pinned Lean toolchain. The pstack create-/maintain-formal-verification-skill and statechart",
			"skills (MIT, Lauren Tan, license text above) are folded into the same skill; the statechart scripts under",
			"resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/statechart/ are copied from pstack with",
			"changes (bun, the shared TLC cache). The tools it downloads on first use (TLA+ tools, CommunityModules,",
			"Temurin JRE, elan, Lean) are fetched from their own releases at pinned versions and are not redistributed.",
			"",
			proofLicense,
		].join("\n"),
		[
			"ECC skills (https://github.com/affaan-m/ECC)",
			`Copyright (c) 2026 Affaan Mustafa, licensed under the MIT License. Skills and prompt commands copied from the ecc-pi-core ${eccPin.version} profile (pi/core, commit ${eccPin.commit}) into resources/omp-builtin/ecc/ by scripts/sync-ecc.ts. Changes: every skill is hidden from the model's skill list and reached through one generated index skill (ecc); the plan command is renamed ecc-plan; skills that duplicate the built-in pstack workflow are left out, references to them point at pstack's counterparts; Claude Code names and paths are replaced by omp ones. The license text is also in resources/omp-builtin/ecc/UPSTREAM-LICENSE.`,
			"",
			eccLicense,
		].join("\n"),
		[
			`Ponytail ${ponytailPin.version} (https://github.com/DietrichGebert/ponytail, commit ${ponytailPin.commit})`,
			"Six unmodified skill documents in resources/omp-builtin/ponytail/skills/. No plugin or hooks are bundled.",
			"Licensed under the MIT License (full text below and in LICENSES/MIT-ponytail.txt).",
			"",
			read("LICENSES/MIT-ponytail.txt"),
		].join("\n"),
		[
			`Interface skills ${interfacesPin.version} by Jakub Krehel (https://github.com/${interfacesPin.repo}, commit ${interfacesPin.commit})`,
			`${interfacesPin.curation.kept.length} unmodified skill folders (Markdown only) in resources/omp-builtin/interfaces/skills/, copied by scripts/sync-interfaces.ts. No plugin manifest or Codex metadata is bundled.`,
			"Licensed under the MIT License (full text below and in LICENSES/MIT-interfaces.txt).",
			"",
			read("LICENSES/MIT-interfaces.txt"),
		].join("\n"),
		[
			"dot-prop 10.2.0 (https://github.com/sindresorhus/dot-prop) and conf 16.0.0",
			"(https://github.com/sindresorhus/conf). dot-prop's parsePath and conf's own-property get, set and",
			"delete of a dotted key, which electron-store gave the preference files, are ported to Rust in",
			"native/ompdesk/crates/core/src/prefs/path.rs. Licensed under the MIT License (full text below and",
			"in LICENSES/MIT-sindresorhus.txt).",
			"",
			read("LICENSES/MIT-sindresorhus.txt"),
		].join("\n"),
		[
			"AI provider brand symbols of @lobehub/icons (@lobehub/icons-static-svg 1.95.1;",
			"Chutes: 1.102.0; https://github.com/lobehub/lobe-icons), Copyright (c) 2023 LobeHub,",
			"licensed under the MIT License (LICENSES/MIT-lobe-icons.txt). The monochrome SVG files",
			"are copied unmodified into",
			"src/renderer/assets/provider-marks/ and shown beside the provider they identify. The symbols",
			"are trademarks or logos of their owners (Anthropic, OpenAI, Google, xAI, DeepSeek, Meta,",
			"GitHub and the others) and identify those providers only; their use here implies no",
			"endorsement.",
			"",
			lobeLicense,
		].join("\n"),
		[
			"Theme palettes (src/renderer/lib/theme-palettes.ts)",
			"The Solarized, Gruvbox and GitHub themes (each a light and a dark one), and the near-monochrome",
			"OMPdesk Light and Dark themes, start from the",
			"colors their authors publish; where a published color fails WCAG AA for text on its own",
			"background it is replaced by a shade of the same hue (see the header of that file). Each",
			"palette is credited below with its license; every one is MIT.",
			"",
			"- Solarized, https://github.com/altercation/solarized, Copyright (c) 2011 Ethan Schoonover",
			"- Gruvbox, https://github.com/morhetz/gruvbox, by Pavel Pertsev (morhetz), licensed MIT",
			"  (package.json; the repository ships no separate license file)",
			"- GitHub Primer primitives, https://github.com/primer/primitives, Copyright (c) 2018 GitHub Inc.",
			"- Orca (OMPdesk Light and Dark, and the app's elevation shadows), https://github.com/stablyai/orca,",
			"  Copyright (c) 2026 Lovecast Inc.",
			"",
			MIT_TEXT,
		].join("\n"),
		[
			"Terminal panel code adapted from Orca (https://github.com/stablyai/orca, commit 02cecc98),",
			"Copyright (c) 2026 Lovecast Inc.: the OSC 52 clipboard parser (src/renderer/lib/terminal-osc52.ts),",
			"shell quoting of a dropped path (src/shared/shell-quote.ts), the scrollback find bar's decoration",
			"colours and its safe find (src/renderer/components/panels/TerminalFind.tsx) and Option's word",
			"motions (src/renderer/lib/terminal-keys.ts).",
			"",
			"Conversation code adapted from the same Orca commit, with changes:",
			"",
			"- src/renderer/components/layout/composer/pasted-links.ts, from",
			"  src/renderer/src/components/native-chat/paste/native-chat-pasted-links.ts and",
			"  src/shared/clipboard/clipboard-link-html.ts (links kept in a paste, a URL over a selection)",
			"- src/renderer/components/chat/transcript-find.ts (`findScrollDelta`), from",
			"  src/renderer/src/components/native-chat/viewport/find/native-chat-find-visibility.ts",
			"- English bot inspector copy in src/renderer/locales/en.ts, from BotItemsSection.tsx and BotUpcomingSection.tsx",
			"",
			"Dictation code adapted from the same Orca commit, with changes:",
			"",
			"- src/renderer/lib/dictation-text.ts (filler words, term spelling), from",
			"  src/shared/speech/dictation/dictation-filler-words.ts, dictation-term-spelling.ts,",
			"  dictation-dictionary.ts and dictation-text-pipeline.ts",
			"- the cleanup request in resources/gui-bridge/stt-language-core.ts, from",
			"  src/shared/speech/dictation/dictation-cleanup.ts",
			"",
			"New task and worktree code adapted from the same Orca commit, with changes:",
			"",
			"- src/main/local/git/setup-draft.ts, from src/shared/workspace-setup/setup-script-import*.ts and",
			"  setup-script-package-manager-suggestion.ts (a setup-hook draft from another tool's config)",
			"- native/ompdesk/crates/core/src/git/sparse.rs and the sparse and parallel checkout of",
			"  native/ompdesk/crates/core/src/git/worktree.rs, from src/main/git/worktrees/creation/",
			"  worktree-sparse-add.ts and checkout-workers-git-args.ts",
			"- src/renderer/stores/new-tasks.ts and src/renderer/components/layout/sidebar/NewTaskRows.tsx, from",
			"  src/renderer/src/components/worktree-creation/worktree-setup-steps.ts, worktree-creation-clock.ts and",
			"  sidebar/worktree-list/rows/PendingWorktreeRow.tsx (a new task's steps on its row)",
			"",
			MIT_TEXT,
		].join("\n"),
		[
			"OMPdesk application icon, tray icons, mark and wordmark (resources/icon.*, resources/brand/,",
			"src/renderer/public/icons/)",
			"Copyright 2026 SeuPut. Original work. The files are licensed under the Apache License 2.0",
			'(LICENSE). As its section 6 says, it grants no permission to use the name "OMPdesk" or its mark,',
			"except as required for reasonable and customary use in describing the origin of the Work and",
			"reproducing the content of the NOTICE file (NOTICE).",
		].join("\n"),
	].join(`\n\n${THIN}\n\n`);
}

function generate(): { text: string; flagged: string[] } {
	const { components, missing } = collect();
	if (missing.length) throw new Error(`dependencies not installed (run bun install): ${missing.join(", ")}`);
	const all = components;

	const groups = new Map<string, Component[]>();
	const flagged: string[] = [];
	const unlicensed: Component[] = [];
	for (const component of all) {
		if (!isPermissive(component.spdx)) flagged.push(`${component.name}@${component.version}: ${component.spdx}`);
		if (!component.text) {
			unlicensed.push(component);
			continue;
		}
		const list = groups.get(component.text) ?? [];
		list.push(component);
		groups.set(component.text, list);
	}

	const ordered = [...groups.entries()].sort(([, a], [, b]) => {
		const x = `${a[0].name}@${a[0].version}`;
		const y = `${b[0].name}@${b[0].version}`;
		return x.localeCompare(y);
	});

	const out: string[] = [];
	out.push(
		"OMPdesk third-party notices",
		"",
		"OMPdesk itself is Copyright 2026 SeuPut and licensed under the Apache License 2.0 (LICENSE,",
		"NOTICE); versions up to and including v0.41.0 were released under the MIT License.",
		"The app is built from the components below and the vendored code credited in section 2;",
		"each is used under the license shown. This file is generated by",
		"scripts/generate-third-party-notices.ts from node_modules (bun run gen:licenses); do not",
		"edit it by hand.",
		"",
		"The desktop shell uses Tauri 2 and the operating system's WebView. The TypeScript main runs on Node.js;",
		"its complete license file, with those of the libraries it bundles, ships as node/LICENSE beside this file.",
		"The historical CEF dependency list remains in section 5 for migration builds, not as a bundled Tauri engine.",
		"",
		`${all.length} npm components, in ${groups.size + unlicensed.length} license texts.`,
		"",
		RULE,
		"1. Components bundled with the app (npm)",
		RULE,
		"",
	);
	for (const [text, list] of ordered) {
		for (const component of list) {
			out.push(`${component.name} ${component.version} (${component.spdx})`);
			if (component.name === "elkjs") {
				out.push(`Source available under EPL-2.0: https://github.com/kieler/elkjs/tree/${component.version}`);
			}
		}
		const copyrights = [...new Set(list.flatMap(component => copyrightLines(component.text)))];
		if (copyrights.length > 1 && list.length > 1) out.push("", ...copyrights);
		out.push("", text, "", THIN, "");
	}
	for (const component of unlicensed) {
		out.push(
			`${component.name} ${component.version} (${component.spdx})`,
			"",
			`This package ships no license file; its package.json declares ${component.spdx}.`,
			"",
			THIN,
			"",
		);
	}
	out.push(RULE, "2. Vendored and bundled non-npm components", RULE, "", vendoredSections(), "");
	out.push(
		RULE,
		`3. Rust crates linked into the bundled ai-memory ${aiMemorySource.version} binary`,
		RULE,
		"",
		committedCrateList("ai-memory"),
		"",
		RULE,
		"4. Rust crates linked into OMPdesk's own native binaries (native/ompdesk)",
		RULE,
		"",
		committedCrateList("ompdesk"),
		"",
		RULE,
		"5. Rust crates linked into OMPdesk's CEF shell (native/ompdesk/crates/shell)",
		RULE,
		"",
		committedCrateList("shell"),
		"",
		RULE,
		"6. Rust crates linked into OMPdesk's Tauri shell (native/ompdesk/crates/tauri-shell)",
		RULE,
		"",
		committedCrateList("tauri"),
		"",
		RULE,
		"7. Rust crates linked into OMPdesk's Preview driver (native/ompdesk/crates/shell-preview)",
		RULE,
		"",
		committedCrateList("preview"),
		"",
	);
	return { text: `${out.join("\n").replace(/\n{4,}/g, "\n\n\n")}`, flagged };
}

const { text, flagged } = generate();
for (const entry of flagged) console.warn(`license needs review: ${entry}`);

if (process.argv.includes("--check")) {
	const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : "";
	if (current !== text) {
		console.error("THIRD_PARTY_NOTICES.txt is stale: run `bun run gen:licenses` and commit it.");
		process.exit(1);
	}
	console.log("THIRD_PARTY_NOTICES.txt is up to date.");
} else {
	writeFileSync(OUTPUT, text);
	console.log(`Wrote THIRD_PARTY_NOTICES.txt (${text.length} bytes).`);
}
