/**
 * The vendor CLIs of connected accounts keep current, end to end, with the fake installer
 * (`OMP_GUI_TEST_INSTALLER`; `OMP_GUI_TEST_CLI_UPDATES=1` lets a test launch check on its own, like the
 * packaged app). Two accounts are connected through a stand-in `discoverAuthStorage` in the fixture omp's
 * package (the stock helper reads it): Anthropic, whose Claude Code 2.0.1 is installed with its own updater,
 * and OpenAI, whose Codex is the copy inside ChatGPT.app. Claude goes check → update → re-detect with nobody
 * clicking: the installer holds the update so This computer shows "Updating…" and a disabled Update now, then
 * releases it and the row reads 2.1.0 from `claude --version`. The bundled Codex is listed with the reason it
 * is left alone and is never checked or touched. With the pref off nothing runs at launch; Update now runs
 * the same cycle. Captures in en/ko. On a Windows runner the user's system proxy is a PAC script naming a local
 * proxy, and a launch with no proxy preference or inherited one checks through it (the order is the core's
 * `proxy.resolve`, whose cases are Rust tests).
 */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { writeFakeOmp } from "../src/main/test-fake-omp";
import { exitApp, fixtureOmp, launchApp, pressShortcutUntilVisible, seedSetupBackoff, variants } from "./harness";

/**
 * `cli-<tool> <method> check` prints the newest version (asked of `OMPDESK_FAKE_FEED` through the spawn's
 * `HTTPS_PROXY` when set: the feed's host resolves nowhere, so only the proxy answers); `update` waits while the
 * `hold` file exists, then "installs" 2.1.0 by writing the version file the fake claude prints. Every call is logged.
 */
const INSTALLER = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const dir = process.env.OMPDESK_FAKE_INSTALLER_DIR;
appendFileSync(join(dir, "installs.log"), args.join(" ") + "\\n");
if (args[0] === "cli-claude" && args[2] === "check") {
	const feed = process.env.OMPDESK_FAKE_FEED;
	if (!feed) console.log("2.1.0");
	else {
		appendFileSync(join(dir, "proxy.log"), (process.env.HTTPS_PROXY ?? "none") + "\\n");
		console.log(await (await fetch(feed, { proxy: process.env.HTTPS_PROXY })).text());
	}
}
if (args[0] === "cli-claude" && args[2] === "update") {
	while (existsSync(join(dir, "hold"))) await Bun.sleep(25);
	writeFileSync(process.env.OMPDESK_FAKE_CLAUDE_VERSION, "2.1.0");
	console.log("Updated Claude Code to 2.1.0");
}
`;

/** The stand-in stock sdk: the providers with a stored credential come from the test's environment. */
const FAKE_SDK = `
export const isManagedMCPOAuthCredentialId = id => typeof id === "string" && id.startsWith("mcp_oauth");
export async function discoverAuthStorage() {
	const providers = (process.env.OMPDESK_FAKE_PROVIDERS ?? "").split(",").filter(Boolean);
	return {
		credentials: { reload: async () => {}, list: () => providers.map((provider, id) => ({ id, provider })) },
		close() {},
	};
}
`;

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	versionFile: string;
	errors: string[];
}

const WIN = process.platform === "win32";
const TOOL_NAMES = ["claude", "codex", "gemini", "cursor-agent", "copilot", "gh", "node"];
/** The files a tool is found as along a PATH: the bare name, or `.exe` and `.cmd` on Windows. */
const TOOL_FILES = TOOL_NAMES.flatMap(name => (WIN ? [`${name}.exe`, `${name}.cmd`] : [name]));

/** The test's PATH without any directory that holds one of the tools, so the developer's own never answers. */
function cleanPath(...extra: string[]): string {
	const rest = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter(dir => dir && !TOOL_FILES.some(file => existsSync(path.join(dir, file))));
	return [...extra, ...rest].join(path.delimiter);
}

async function launch(
	name: string,
	prefs: Record<string, unknown>,
	env: Record<string, string> = {},
): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `omp-cli-update-${name}-`)));
	const home = path.join(root, "home");
	const desktop = path.join(root, "desktop");
	const project = path.join(root, "project");
	const agent = path.join(root, "agent");
	const installerDir = path.join(root, "installer");
	const bin = path.join(root, "bin");
	await Promise.all([home, desktop, project, agent, installerDir, bin].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ firstRunComplete: true, themeName: "light", ...prefs }),
	);
	// Machine setup's optional gh, Node and agent-desktop have nothing to install here: keep the launch quiet.
	await seedSetupBackoff(desktop, ["gh", "node", "agent-desktop"]);

	// Claude Code 2.0.1, installed with its own updater and found on PATH: on POSIX under …/share/claude/versions/…,
	// linked from a bin dir; on Windows a `.cmd` shim in the bin dir. The Codex inside the ChatGPT app, which updates
	// it: `ChatGPT.app/Contents/` on a Mac, the app's `WindowsApps` package folder on Windows.
	const versionFile = path.join(root, "claude-version");
	await fs.writeFile(versionFile, "2.0.1");
	let codexDir = bin;
	if (WIN) {
		await fs.writeFile(
			path.join(bin, "claude.cmd"),
			`@echo off\r\nset /p version=<"${versionFile}"\r\necho %version% (Claude Code)\r\n`,
		);
		codexDir = path.join(root, "WindowsApps", "OpenAI.ChatGPT");
		await fs.mkdir(codexDir, { recursive: true });
		await fs.writeFile(path.join(codexDir, "codex.cmd"), "@echo off\r\necho codex-cli 0.46.0\r\n");
	} else {
		const claude = path.join(home, ".local", "share", "claude", "versions", "stable", "claude");
		await fs.mkdir(path.dirname(claude), { recursive: true });
		await fs.writeFile(claude, `#!/bin/sh\necho "$(cat '${versionFile}') (Claude Code)"\n`, { mode: 0o755 });
		await fs.symlink(claude, path.join(bin, "claude"));
		const codex = path.join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex");
		await fs.mkdir(path.dirname(codex), { recursive: true });
		await fs.writeFile(codex, "#!/bin/sh\necho 'codex-cli 0.46.0'\n", { mode: 0o755 });
		await fs.symlink(codex, path.join(bin, "codex"));
	}

	const omp = await fixtureOmp(root);
	const stock = path.join(path.dirname(omp), "node_modules", "@oh-my-pi", "pi-coding-agent");
	const manifest: { exports: Record<string, string> } = JSON.parse(
		await fs.readFile(path.join(stock, "package.json"), "utf8"),
	);
	manifest.exports["./sdk"] = "./sdk.ts";
	manifest.exports["./mcp/oauth-flow"] = "./sdk.ts";
	await fs.writeFile(path.join(stock, "package.json"), JSON.stringify(manifest));
	await fs.writeFile(path.join(stock, "sdk.ts"), FAKE_SDK);

	const PATH = cleanPath(bin, ...(codexDir === bin ? [] : [codexDir]));
	// The login-shell probe would add Homebrew's dirs (path_helper); this one reports PATH as it is. Windows has no probe.
	const shell = path.join(root, "login-shell");
	if (!WIN)
		await fs.writeFile(shell, `#!/bin/sh\nexec /usr/bin/env PATH='${PATH}' /bin/sh -c "$2"\n`, { mode: 0o755 });
	const installer = await writeFakeOmp(installerDir, INSTALLER);
	await fs.writeFile(path.join(installerDir, "hold"), "");
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: {
			PATH,
			...(WIN ? {} : { SHELL: shell }),
			HOME: home,
			PI_CONFIG_DIR: "omp-config",
			OMP_GUI_OMP: omp,
			OMP_GUI_TEST_INSTALLER: installer,
			OMP_GUI_TEST_CLI_UPDATES: "1",
			OMP_GUI_TEST_BREW_DIRS: "",
			// No bundled agent-desktop, whether or not this checkout ran `bun run build:agent-desktop`: machine setup's
			// tools are not installed here.
			OMP_GUI_TEST_AGENT_DESKTOP_BUNDLE: path.join(root, "no-agent-desktop"),
			OMPDESK_FAKE_INSTALLER_DIR: installerDir,
			OMPDESK_FAKE_CLAUDE_VERSION: versionFile,
			OMPDESK_FAKE_PROVIDERS: "anthropic,openai-codex",
			...env,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1180, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page, root, versionFile, errors };
}

async function close(launched: Launched): Promise<void> {
	await exitApp(launched.app);
	await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function installs(launched: Launched): Promise<string[]> {
	const log = await fs.readFile(path.join(launched.root, "installer", "installs.log"), "utf8").catch(() => "");
	return log.split("\n").filter(line => line.startsWith("cli-"));
}

const release = (launched: Launched) => fs.rm(path.join(launched.root, "installer", "hold"), { force: true });

async function openThisComputer(page: Page) {
	const settings = page.locator("[data-settings-page]");
	await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
	await settings.locator('[data-settings-section="updates"]').click();
	await expect(settings.locator("#setting-gui-toolsAutoUpdate")).toBeVisible();
	return settings;
}

for (const language of variants(["en", "ko"] as const)) {
	test(`a connected account's Claude Code updates on its own: check, update, re-detect; a bundled Codex is left alone (${language})`, async () => {
		test.setTimeout(120_000);
		const launched = await launch(`auto-${language}`, { language });
		const { page } = launched;
		// The tool CLIs' rows end This computer's list, below the fold of a 900 px window: scroll them to the top.
		const shot = async (name: string) => {
			await page.locator("#setting-cli-tool-claude").evaluate(row => row.scrollIntoView({ block: "start" }));
			await page.mouse.move(1, 1);
			await page.locator("[data-settings-page]").screenshot({
				animations: "disabled",
				path: test.info().outputPath(`cli-update-${language}-${name}.png`),
			});
		};
		const t = (en: string, ko: string) => (language === "en" ? en : ko);
		try {
			const settings = await openThisComputer(page);
			const claude = settings.locator("#setting-cli-tool-claude");
			const codex = settings.locator("#setting-cli-tool-codex");
			await expect(settings.locator("#setting-gui-toolsAutoUpdate [role='switch']")).toHaveAttribute(
				"aria-checked",
				"true",
			);

			// Nobody clicked: main checked, found 2.1.0 > 2.0.1 and runs the update, which the installer holds.
			await expect(settings.getByTestId("cli-status-claude")).toHaveText(t("Updating…", "업데이트하는 중이에요…"), {
				timeout: 60_000,
			});
			await expect(settings.getByTestId("cli-version-claude")).toHaveText(
				t("Installed 2.0.1 · Latest 2.1.0", "설치됨 2.0.1 · 최신 2.1.0"),
			);
			await expect(claude).toContainText(t("Updated via its own updater", "업데이트 방법: 자체 업데이터"));
			await expect(claude.getByTestId("cli-update-now-claude")).toBeDisabled();
			await expect
				.poll(() => installs(launched), { timeout: 30_000 })
				.toEqual(["cli-claude self check", "cli-claude self update"]);

			// The Codex in ChatGPT.app is listed with its reason, and never checked or updated.
			await expect(settings.getByTestId("cli-version-codex")).toHaveText(t("Installed 0.46.0", "설치됨 0.46.0"));
			await expect(settings.getByTestId("cli-status-codex")).toHaveText(
				t(
					"This copy ships inside another app, which updates it.",
					"다른 앱 안에 들어 있는 사본이라 그 앱이 업데이트해요.",
				),
			);
			await expect(codex.getByTestId("cli-update-now-codex")).toBeDisabled();
			await shot("1-updating");

			await release(launched);
			await expect(settings.getByTestId("cli-status-claude")).toHaveText(
				t("Updated 2.0.1 → 2.1.0.", "2.0.1 → 2.1.0 업데이트했어요."),
				{ timeout: 30_000 },
			);
			// Re-detected: the tool itself reports 2.1.0 now.
			await expect(settings.getByTestId("cli-version-claude")).toHaveText(
				t("Installed 2.1.0 · Latest 2.1.0", "설치됨 2.1.0 · 최신 2.1.0"),
			);
			expect(await fs.readFile(launched.versionFile, "utf8")).toBe("2.1.0");
			await expect(claude.getByTestId("cli-update-now-claude")).toBeEnabled();
			await shot("2-updated");

			// Only claude was ever asked; machine setup's tools are not installed here, so nothing else is listed.
			expect(await installs(launched)).toEqual(["cli-claude self check", "cli-claude self update"]);
			await expect(settings.locator("[data-cli-tool]")).toHaveCount(2);
			expect(launched.errors).toEqual([]);
		} finally {
			await close(launched);
		}
	});
}

const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/** The registry's current `DefaultConnectionSettings` blob as hex, or none. */
function connectionSettingsNow(): string | undefined {
	try {
		const out = execFileSync(
			"reg",
			["query", `${INTERNET_SETTINGS}\\Connections`, "/v", "DefaultConnectionSettings"],
			{
				encoding: "utf8",
			},
		);
		return /DefaultConnectionSettings\s+REG_BINARY\s+([0-9A-F]+)/i.exec(out)?.[1];
	} catch {
		return undefined;
	}
}

/**
 * WinINET's connection blob naming only `pacUrl` (`DefaultConnectionSettings`: version, change counter, flags
 * DIRECT | AUTO_PROXY_URL, then length-prefixed proxy, bypass list and script URL), its counter one past the current.
 */
function pacConnectionSettings(pacUrl: string): string {
	const current = connectionSettingsNow();
	const counter = current ? Buffer.from(current, "hex").readUInt32LE(4) + 1 : 1;
	const dword = (n: number) => {
		const bytes = Buffer.alloc(4);
		bytes.writeUInt32LE(n);
		return bytes;
	};
	const text = (s: string) => Buffer.concat([dword(Buffer.byteLength(s)), Buffer.from(s, "ascii")]);
	return Buffer.concat([dword(0x46), dword(counter), dword(0x05), text(""), text(""), text(pacUrl), Buffer.alloc(32)])
		.toString("hex")
		.toUpperCase();
}

// The system proxy is this Windows user's own setting: only a runner, whose account is thrown away, gets it changed.
test("a tool check goes through the system proxy a PAC script names (Windows)", async () => {
	test.skip(
		!WIN || !process.env.GITHUB_ACTIONS,
		"changes this computer's system proxy: GitHub's Windows runners only",
	);
	test.setTimeout(120_000);
	const FEED = "http://ompdesk-update.invalid/claude";
	const proxied: string[] = [];
	const server = createServer((request, response) => {
		if (request.url === "/proxy.pac") {
			response.writeHead(200, { "content-type": "application/x-ns-proxy-autoconfig" });
			response.end(`function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${port}"; }`);
			return;
		}
		// An absolute-form request is a proxy's: the only way the feed's host, which resolves nowhere, is reached.
		proxied.push(`${request.method} ${request.url}`);
		response.end(request.url === FEED ? "2.1.0" : "");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const backup = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "omp-internet-settings-")), "backup.reg");
	execFileSync("reg", ["export", INTERNET_SETTINGS, backup, "/y"]);
	let launched: Launched | undefined;
	try {
		const pac = `http://127.0.0.1:${port}/proxy.pac`;
		execFileSync("reg", ["add", INTERNET_SETTINGS, "/v", "AutoConfigURL", "/t", "REG_SZ", "/d", pac, "/f"]);
		const blob = pacConnectionSettings(pac);
		execFileSync("reg", [
			"add",
			`${INTERNET_SETTINGS}\\Connections`,
			"/v",
			"DefaultConnectionSettings",
			"/t",
			"REG_BINARY",
			"/d",
			blob,
			"/f",
		]);
		// No proxy inherited from the runner's environment: the system's is the one the order reaches.
		const noInherited = { PI_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "" };
		const current = await launch("system-proxy", {}, { ...noInherited, OMPDESK_FAKE_FEED: FEED });
		launched = current;
		await expect
			.poll(() => installs(current), { timeout: 60_000 })
			.toEqual(["cli-claude self check", "cli-claude self update"]);
		const seen = await fs.readFile(path.join(current.root, "installer", "proxy.log"), "utf8");
		expect(seen.trim().split(/\r?\n/)).toEqual([`http://127.0.0.1:${port}`]);
		expect(proxied).toContain(`GET ${FEED}`);
	} finally {
		if (launched) {
			await release(launched);
			await close(launched);
		}
		server.close();
		try {
			execFileSync("reg", ["delete", INTERNET_SETTINGS, "/v", "AutoConfigURL", "/f"]);
		} catch {}
		execFileSync("reg", ["import", backup]);
	}
});
