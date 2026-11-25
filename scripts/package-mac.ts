/**
 * Package OMPdesk for macOS (Apple silicon) from the Tauri 2 shell.
 *
 *   bun run package:mac [-- --no-dmg] [-- --legacy-zip] [-- --version <v>] [-- --sign-with <identity> --keychain <file>]
 *
 * Assemble `dist/mac-arm64/OMPdesk.app`, validate it with `scripts/after-pack.cjs`, sign with the existing app
 * identity, then hand the finished bundle to electron-builder for the DMG only (`--prepackaged`).
 *
 * Inputs, all gitignored and built beforehand (CI's `mac` job does it in this order): `out/` (`bun run build`),
 * `resources/ompdesk-tauri/darwin-arm64/` (`bun scripts/build-tauri.ts`), `resources/node/darwin-arm64/`
 * (`bun run build:node`), `resources/ompdesk-bin/`, `resources/ai-memory-bin/` and `resources/agent-desktop-bin/`
 * (each for darwin-arm64). Historical CEF assembly is retained only for the migration regression fixture.
 *
 * Signing (scripts/mac-sign.cjs): OMPdesk's own pinned certificate, so the designated requirement is `identifier
 * "com.seuput.ompdesk" and certificate root = H"…"` in every release and macOS keeps its privacy grants; ad-hoc without
 * it (an error with `OMPDESK_MAC_SIGNING_REQUIRED=1`). Every Mach-O is signed inside out with hardened runtime and
 * `resources/entitlements.mac.plist` (Node's V8 needs JIT), no secure timestamp (nothing is notarized), then the app,
 * which `stageBundleFromDmg` (src/main/updater-state.ts) verifies with
 * `codesign --verify --deep --strict` after the update.
 *
 * Release acceptance covers the actual signed bundle, the released app's automatic update and rollback,
 * existing encrypted credentials without a permission prompt, and persisted page/user data across restart.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import compatibility from "../src/shared/app-compatibility.json";

// CommonJS modules shared with the packaging check.
const require = createRequire(import.meta.url);
interface PackContext {
	electronPlatformName: string;
	appOutDir: string;
	packager: { appInfo: { productFilename: string } };
}
interface Helper {
	suffix: string;
	id: string;
}
const plist = require("plist") as { build: (value: Record<string, unknown>) => string };
const { afterPack } = require("./after-pack.cjs") as { afterPack: (context: PackContext) => Promise<void> };
const bundle = require("./mac-bundle-info.cjs") as {
	APP_ID: string;
	PRODUCT: string;
	FRAMEWORK: string;
	SHELL: string;
	LAUNCHER: string;
	HELPERS: Helper[];
	frameworkRoot: (framework: string) => string;
	appInfo: (version: string) => Record<string, unknown>;
	helperInfo: (version: string, helper: Helper, prefix: string) => Record<string, unknown>;
	HELPER_PREFIXES: string[];
	helperName: (prefix: string, helper: Helper) => string;
};
const { withSigningIdentity } = require("./mac-sign.cjs") as {
	withSigningIdentity: (body: (signing: { identity: string; keychain: string | null }) => unknown) => Promise<unknown>;
};

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "darwin-arm64";
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function fail(message: string): never {
	console.error(`package:mac: ${message}`);
	process.exit(1);
}

/** The `Contents/Resources` entries copied as they are: [source under the repository, destination under Resources]. */
export const RESOURCE_COPIES: [string, string][] = [
	["resources/gui-bridge", "gui-bridge"],
	["resources/node/darwin-arm64", "node"],
	["resources/ompdesk-bin/darwin-arm64", "ompdesk-bin"],
	["resources/omp-builtin", "omp-builtin"],
	["resources/ai-memory-bin/darwin-arm64", "ai-memory-bin"],
	["resources/agent-desktop-bin/darwin-arm64", "agent-desktop-bin"],
	["resources/brand/app-icon.png", "app-icon.png"],
	["resources/icon.icns", "icon.icns"],
	["LICENSE", "LICENSE"],
	["NOTICE", "NOTICE"],
	["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
	["LICENSES", "LICENSES"],
];

const LEGACY_LICENSE_COPIES: [string, string][] = [
	["resources/shell-licenses/darwin-arm64/LICENSES.chromium.html", "LICENSES.chromium.html"],
	["resources/shell-licenses/darwin-arm64/LICENSE.cef.txt", "LICENSE.cef.txt"],
];

/** The Tauri host's Preview browser, staged by scripts/stage-preview-browser.ts; the host reads `Resources/preview-browser/runtime.json`. */
export const TAURI_COPIES: [string, string][] = [["resources/preview-browser/darwin-arm64", "preview-browser"]];

const copy = (from: string, to: string) => {
	fs.mkdirSync(path.dirname(to), { recursive: true });
	// Symlinks stay links: CEF's framework is `Versions/A` with `Current` and top-level links into it.
	fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: true });
};

/**
 * Assemble `<out>/OMPdesk.app` from staged inputs under `repo`. The launcher keeps the original app identity;
 * `ompdesk-shell` hosts the page and starts the existing Node services.
 */
export function assembleBundle(
	repo: string,
	out: string,
	version?: string,
	runtime: "tauri" | "cef" = "tauri",
): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
	if (version) manifest.version = version;
	const staged = path.join(repo, "resources", runtime === "tauri" ? "ompdesk-tauri" : "ompdesk-shell", KEY);
	const recordFile = path.join(staged, runtime === "tauri" ? "ompdesk-tauri.build.json" : "ompdesk-shell.build.json");
	if (!fs.existsSync(recordFile)) fail(`${recordFile} is missing; stage the ${runtime} runtime before packaging`);
	const record = JSON.parse(fs.readFileSync(recordFile, "utf8")) as {
		binary: string;
		launcher: string;
		files: Record<string, string>;
		engine?: string;
	};
	if (record.binary !== bundle.SHELL || record.launcher !== bundle.LAUNCHER) {
		fail(`${recordFile} names ${record.binary} and ${record.launcher}, not ${bundle.SHELL} and ${bundle.LAUNCHER}`);
	}
	if (runtime === "tauri" && record.engine !== "tauri") fail(`${recordFile} is not a Tauri runtime`);
	for (const name of Object.keys(record.files)) {
		if (
			name !== record.binary &&
			name !== record.launcher &&
			!(runtime === "cef" && name.startsWith(`${bundle.FRAMEWORK}/`))
		) {
			fail(`${recordFile} lists ${name}; the bundle holds the shell, the launcher and ${bundle.FRAMEWORK} only`);
		}
	}
	const app = path.join(out, `${bundle.PRODUCT}.app`);
	const contents = path.join(app, "Contents");
	const frameworks = path.join(contents, "Frameworks");
	const resources = path.join(contents, "Resources");
	fs.rmSync(app, { recursive: true, force: true });
	for (const dir of [path.join(contents, "MacOS"), frameworks, resources]) fs.mkdirSync(dir, { recursive: true });

	for (const [from, to] of [
		[record.launcher, bundle.PRODUCT],
		[record.binary, bundle.SHELL],
	] as const) {
		fs.copyFileSync(path.join(staged, from), path.join(contents, "MacOS", to));
		fs.chmodSync(path.join(contents, "MacOS", to), 0o755);
	}
	if (runtime === "cef") copy(path.join(staged, bundle.FRAMEWORK), path.join(frameworks, bundle.FRAMEWORK));
	const info = bundle.appInfo(manifest.version);
	if (runtime === "tauri") info.LSMinimumSystemVersion = compatibility.minimumMacOS;
	fs.writeFileSync(path.join(contents, "Info.plist"), plist.build(info));
	for (const prefix of runtime === "cef" ? bundle.HELPER_PREFIXES : []) {
		for (const helper of bundle.HELPERS) {
			const name = bundle.helperName(prefix, helper);
			const helperApp = path.join(frameworks, `${name}.app`, "Contents");
			fs.mkdirSync(path.join(helperApp, "MacOS"), { recursive: true });
			fs.copyFileSync(path.join(staged, record.binary), path.join(helperApp, "MacOS", name));
			fs.chmodSync(path.join(helperApp, "MacOS", name), 0o755);
			fs.writeFileSync(
				path.join(helperApp, "Info.plist"),
				plist.build(bundle.helperInfo(manifest.version, helper, prefix)),
			);
		}
	}
	fs.copyFileSync(
		recordFile,
		path.join(resources, runtime === "tauri" ? "ompdesk-tauri.build.json" : "ompdesk-shell.build.json"),
	);

	const copies =
		runtime === "cef" ? [...RESOURCE_COPIES, ...LEGACY_LICENSE_COPIES] : [...RESOURCE_COPIES, ...TAURI_COPIES];
	for (const [from, to] of copies) {
		const source = path.join(repo, from);
		if (!fs.existsSync(source))
			fail(`${source} is missing (see the header of scripts/package-mac.ts for what builds it)`);
		copy(source, path.join(resources, to));
	}
	// The app folder the shell starts the main from: the repository's own package.json and the build, a plain folder.
	const appDir = path.join(resources, "app");
	if (!fs.existsSync(path.join(repo, "out", "main", "index.js")))
		fail("out/ has no main/index.js; run `bun run build`");
	fs.mkdirSync(appDir, { recursive: true });
	fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	// The CEF shell's preload (out/preload/shell.js) is not part of a Tauri bundle; the host injects out/preload/tauri.js.
	const cefPreload = path.join(repo, "out", "preload", "shell.js");
	fs.cpSync(path.join(repo, "out"), path.join(appDir, "out"), {
		recursive: true,
		filter: source =>
			![".build-stamp.json", ".used"].includes(path.basename(source)) &&
			!(runtime === "tauri" && source === cefPreload),
	});
	return app;
}

/** Every regular file under `dir` whose first bytes are a Mach-O (or fat) header, deepest first (children sign before parents). */
export function machOFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const file = path.join(current, entry.name);
			if (entry.isDirectory()) walk(file);
			else if (entry.isFile()) {
				const handle = fs.openSync(file, "r");
				const head = Buffer.alloc(4);
				const read = fs.readSync(handle, head, 0, 4, 0);
				fs.closeSync(handle);
				if (read === 4 && MACHO_MAGIC.has(head.readUInt32BE(0))) found.push(file);
			}
		}
	};
	walk(dir);
	return found.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
}

function codesign(args: string[]): void {
	const run = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
	if (run.status !== 0) fail(`codesign ${args.join(" ")} failed: ${run.stderr || run.error}`);
}

/** Sign `app` inside out with the identity `withSigningIdentity` hands over. */
export function signBundle(app: string, identity: string, keychain: string | null): void {
	const options = [
		"--force",
		"--options",
		"runtime",
		"--timestamp=none",
		"--entitlements",
		path.join(REPO_ROOT, "resources", "entitlements.mac.plist"),
		"--sign",
		identity,
		...(keychain ? ["--keychain", keychain] : []),
	];
	const contents = path.join(app, "Contents");
	const framework = path.join(contents, "Frameworks", bundle.FRAMEWORK);
	// Loose Mach-O files first (Node, the Rust binaries, agent-desktop, CEF's libraries), then the framework as a
	// bundle, the helper apps and the app. The framework's own executable is sealed by signing the framework.
	const hasCef = fs.existsSync(framework);
	const frameworkExecutable = hasCef
		? path.join(bundle.frameworkRoot(framework), "Chromium Embedded Framework")
		: null;
	// The Preview browser keeps its vendor signature (scripts/stage-preview-browser.ts verified it); the app seal
	// hashes it as a resource, so it is never re-signed with OMPdesk's identity.
	const vendor = path.join(contents, "Resources", "preview-browser");
	for (const dir of [path.join(contents, "Resources"), ...(hasCef ? [bundle.frameworkRoot(framework)] : [])]) {
		for (const file of machOFiles(dir)) {
			if (file !== frameworkExecutable && !file.startsWith(`${vendor}${path.sep}`)) codesign([...options, file]);
		}
	}
	if (hasCef) codesign([...options, framework]);
	for (const prefix of hasCef ? bundle.HELPER_PREFIXES : []) {
		for (const helper of bundle.HELPERS) {
			codesign([...options, path.join(contents, "Frameworks", `${bundle.helperName(prefix, helper)}.app`)]);
		}
	}
	// The shell is a code object of its own inside Contents/MacOS (only the CFBundleExecutable is sealed with the app):
	// its identifier is the bundle's, so the requirement of the keychain item Electron made (`identifier
	// "com.seuput.ompdesk" and certificate root = …`) holds for the process that reads it. The launcher is the app's
	// own executable, signed with the app.
	codesign([...options, "--identifier", bundle.APP_ID, path.join(contents, "MacOS", bundle.SHELL)]);
	codesign([...options, app]);
	codesign(["--verify", "--deep", "--strict", "--verbose=2", app]);
}

/**
 * The shell is not the bundle's CFBundleExecutable, so Foundation reads its main bundle's identifier from the
 * Info.plist embedded in its own binary (`native/ompdesk/crates/tauri-shell/Info.plist`); 0.133.0's had none, and every
 * macOS notification failed ("macOS notifications need the app to run from an application bundle").
 */
function checkShellIdentity(app: string): void {
	const shell = path.join(app, "Contents", "MacOS", bundle.SHELL);
	const embedded = spawnSync("launchctl", ["plist", "__TEXT,__info_plist", shell], { encoding: "utf8" });
	if (embedded.status !== 0 || !embedded.stdout.includes(`"CFBundleIdentifier" = "${bundle.APP_ID}";`))
		fail(`${shell} embeds no CFBundleIdentifier ${bundle.APP_ID}: ${embedded.stdout}${embedded.stderr}`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (process.platform !== "darwin") fail("run this on a Mac (codesign, hdiutil)");
	const out = path.join(REPO_ROOT, "dist", "mac-arm64");
	// `--version <v>`: another version than package.json's (the update dry run offers 0.200.0 from a released 0.127.0).
	const versionAt = args.indexOf("--version");
	const version = versionAt >= 0 ? args[versionAt + 1] : undefined;
	const runtime = args.includes("--historical-cef") ? "cef" : "tauri";
	const app = assembleBundle(REPO_ROOT, out, version, runtime);
	if (runtime === "tauri") checkShellIdentity(app);
	await afterPack({
		electronPlatformName: "darwin",
		appOutDir: out,
		packager: { appInfo: { productFilename: bundle.PRODUCT } },
	});
	// `--sign-with <identity> --keychain <file>`: a throwaway identity of a CI check (scripts/shell-move/keychain-ci.sh
	// signs the shell with a certificate it made a minute ago); a release never passes it.
	const signWith = args[args.indexOf("--sign-with") + 1];
	if (args.includes("--sign-with") && signWith) {
		const at = args.indexOf("--keychain");
		signBundle(app, signWith, at >= 0 ? (args[at + 1] ?? null) : null);
	} else {
		await withSigningIdentity(({ identity, keychain }) => {
			signBundle(app, identity, keychain);
		});
	}
	if (args.includes("--no-dmg")) return;
	// The legacy update feed (release.yml's LEGACY_UPDATE_FEED) also wants the ZIP.
	const targets = args.includes("--legacy-zip") ? ["dmg", "zip"] : ["dmg"];
	const builder = spawnSync(
		"bunx",
		[
			"electron-builder",
			"--mac",
			...targets,
			"--arm64",
			"--publish",
			"never",
			...(version ? [`-c.extraMetadata.version=${version}`] : []),
			"--prepackaged",
			app,
		],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
	if (builder.status !== 0) fail("electron-builder failed");
}

if (import.meta.main) await main();
