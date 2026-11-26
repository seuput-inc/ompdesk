/**
 * The parity sheet (`bun run parity -- <surface…>`, scripts/parity.ts): each named surface of
 * e2e/responsive-surfaces.ts that declares a `parity` session, captured on the same session of one computer (B, the
 * host) three ways: B's own desktop window, another OMPdesk paired with B viewing that session from B's section of its
 * sidebar (A, the remote host view), and B's phone page at 390×844 (Chromium as a phone behind the fake
 * `tailscale serve`, e2e/fixture/phone-serve.ts). Two apps on the fake omp (e2e/remote-harness.ts), en light.
 *
 * Registered only with OMP_GUI_PARITY=<dir>; OMP_GUI_PARITY_ONLY=<id,…> picks the surfaces (default: every one with a
 * `parity` session). Writes `<dir>/<surface>/{local,remote,phone}.png`, `<dir>/<surface>/sheet.png` (the three side by
 * side, labelled) and `<dir>/parity.json`. A view that cannot reach a surface (its `ready` never shows, the renderer
 * or a panel crashed) fails the test naming the surface and the view, and that surface gets no sheet.
 * OMP_GUI_PARITY_ORDERS=both is the order check instead (`bun run parity -- --both-orders`): two tests side by side,
 * every surface into `<dir>/forward` and every surface in reverse order into `<dir>/reverse`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Browser, chromium, devices, expect, type Locator, type Page, test } from "@playwright/test";
import { STRESS_PROMPT } from "../src/renderer/dev-harness/fixture";
import { phonePaired, ServeProxy, serveSites } from "./fixture/phone-serve";
import { writeShellGh } from "./fixture/shell-gh";
import { controlToolCaller, cssString, exitApp, openedSessions, untilAnswered } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, REMOTE_LOGIN, type RemoteInstance } from "./remote-harness";
import { crashed, type Look, panelCrash } from "./responsive-audit";
import { PARITY_WORK_PROMPT, type ParitySession, SURFACES, type Surface } from "./responsive-surfaces";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * B's `gh`: signed in, the project's repository `o/r` with one open PR whose detail has a file, a passing check and an
 * open review thread, one open issue with its detail and one project (`agents-prs`, `agents-pr-detail`, `agents-github`,
 * `agents-github-projects`, `agents-issue-detail`, `agents-issue-start`). The project's own branch
 * has no PR (`--head`), so the sidebar rows show none and the Changes panel offers to link one.
 */
async function writeParityGh(bin: string): Promise<void> {
	const pr = {
		number: 7,
		title: "Show each session's pull request beside it",
		url: "https://github.com/o/r/pull/7",
		isDraft: false,
		author: { login: "dev" },
		headRefName: "feature/session-prs",
		baseRefName: "main",
		additions: 42,
		deletions: 7,
		updatedAt: "2026-11-20T10:00:00Z",
		reviewDecision: "REVIEW_REQUIRED",
		statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" }],
	};
	const hunk = "@@ -1,2 +1,3 @@\n export const rows = 1;\n+export const pr = 7;\n export const gap = 4;";
	const json = (file: string, value: unknown) => fs.writeFile(path.join(bin, file), JSON.stringify(value));
	await fs.mkdir(bin, { recursive: true });
	await Promise.all([
		json("list.json", [pr]),
		json("view.json", {
			...pr,
			body: "Links each session to the pull request of its branch.",
			state: "OPEN",
			mergeStateStatus: "BLOCKED",
			files: [{ path: "src/session-prs.ts", additions: 42, deletions: 7 }],
			id: "PR_7",
			headRefOid: "0123456789abcdef0123456789abcdef01234567",
			autoMergeRequest: null,
			reviewRequests: [{ login: "reviewer" }],
			assignees: [{ login: "dev" }],
			labels: [{ name: "enhancement" }],
		}),
		json("comments.json", { comments: [], reviews: [] }),
		json("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						id: "PR_7",
						reviewThreads: {
							nodes: [
								{
									id: "T_1",
									isResolved: false,
									path: "src/session-prs.ts",
									line: 2,
									comments: {
										nodes: [
											{
												id: "C_1",
												author: { login: "reviewer" },
												body: "Should a closed PR keep its row?",
												createdAt: "2026-11-20T11:00:00Z",
												url: "https://github.com/o/r/pull/7#discussion_r1",
												diffHunk: hunk,
											},
										],
									},
								},
							],
						},
					},
				},
			},
		}),
		fs.writeFile(
			path.join(bin, "pr.diff"),
			`diff --git a/src/session-prs.ts b/src/session-prs.ts\n--- a/src/session-prs.ts\n+++ b/src/session-prs.ts\n${hunk}\n`,
		),
	]);
	await writeShellGh(
		bin,
		[
			"#!/bin/sh",
			'case "$*" in',
			`"auth status"*) echo "github.com" >&2; echo "  ✓ Logged in to github.com account dev (keyring)" >&2 ;;`,
			// Agents › GitHub › Projects: the account's one project (both discovery reads name `projectsV2`).
			`"api"*projectsV2*) echo '{"data":{"viewer":{"login":"dev","projectsV2":{"nodes":[{"id":"PVT_1","number":3,"title":"Session work","url":"https://github.com/users/dev/projects/3","owner":{"__typename":"User","login":"dev"}}]},"organizations":{"nodes":[]}}}}' ;;`,
			`"api"*graphql*) cat "${bin}/graphql.json" ;;`,
			`"api"*rate_limit*) echo '{"resources":{"core":{"limit":5000,"remaining":4990,"reset":1900000000},"graphql":{"limit":5000,"remaining":4990,"reset":1900000000}}}' ;;`,
			`"api user"*) echo '{"login":"dev"}' ;;`,
			`"api"*) echo '[]' ;;`,
			`"repo view"*) echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;`,
			`"pr list"*--head*) echo '[]' ;;`,
			`"pr list"*) cat "${bin}/list.json" ;;`,
			`"pr view"*comments,reviews*) cat "${bin}/comments.json" ;;`,
			`"pr view"*) cat "${bin}/view.json" ;;`,
			`"pr diff"*) cat "${bin}/pr.diff" ;;`,
			`"issue view"*) echo '{"number":12,"title":"Closed PRs keep their session row","state":"OPEN","author":{"login":"reviewer"},"labels":[{"name":"bug"}],"comments":[],"updatedAt":"2026-11-20T09:00:00Z","url":"https://github.com/o/r/issues/12","body":"A session whose pull request closed still shows the PR beside its row."}' ;;`,
			`"issue list"*) echo '[{"number":12,"title":"Closed PRs keep their session row","state":"OPEN","author":{"login":"reviewer"},"labels":[{"name":"bug"}],"comments":[],"updatedAt":"2026-11-20T09:00:00Z","url":"https://github.com/o/r/issues/12"}]' ;;`,
			`"label list"*|"release list"*|"run list"*|"workflow list"*|"repo list"*) echo '[]' ;;`,
			"*) exit 1 ;;",
			"esac",
			"",
		].join("\n"),
	);
}

/**
 * B's project is a git checkout with uncommitted work, so the work session's Changes panel shows its source control
 * and a changed file list, and its Files view has a nested file to open (`panel-diff`, `panel-files-viewer`). Its
 * history forks and joins (a feature branch of two commits merged beside a commit on main), so `panel-graph` draws
 * lanes, and Sidebar.tsx's lines come from two commits and the working tree, so `panel-blame` shows each.
 */
async function seedProject(project: string): Promise<void> {
	const nested = path.join(project, "src/renderer/components/layout/sidebar");
	const sidebar = path.join(nested, "Sidebar.tsx");
	await fs.mkdir(nested, { recursive: true });
	await fs.writeFile(path.join(project, "README.md"), "# Project\n");
	await fs.writeFile(sidebar, "export const rows = 2;\n");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "parity@example.com");
	git(project, "config", "user.name", "Parity");
	git(project, "config", "commit.gpgsign", "false");
	git(project, "add", ".");
	git(project, "commit", "-qm", "feat: seed the project");
	git(project, "checkout", "-q", "-b", "feature/sidebar-gap");
	await fs.writeFile(sidebar, "export const rows = 2;\nexport const gap = 4;\n");
	git(project, "commit", "-qam", "feat(sidebar): a gap between rows");
	await fs.writeFile(path.join(project, "README.md"), "# Project\n\nThe sidebar keeps a gap between rows.\n");
	git(project, "commit", "-qam", "docs: say what the gap is for");
	git(project, "checkout", "-q", "main");
	await fs.writeFile(path.join(project, "package.json"), '{ "name": "project" }\n');
	git(project, "add", "package.json");
	git(project, "commit", "-qm", "chore: name the package");
	git(
		project,
		"merge",
		"-q",
		"--no-ff",
		"--no-edit",
		"-m",
		"Merge branch 'feature/sidebar-gap'",
		"feature/sidebar-gap",
	);
	await fs.writeFile(sidebar, "export const rows = 2;\nexport const gap = 4;\nexport const pad = 8;\n");
	await fs.writeFile(path.join(project, "wait-for.ts"), "export const waitFor = () => {};\n");
}

const dir = process.env.OMP_GUI_PARITY;
const BLOCKED_USAGE = process.env.OMP_GUI_TEST_USAGE_ACCOUNTS === "blocked";
const language = process.env.OMP_GUI_PARITY_LANGUAGE === "ko" ? "ko" : "en";

const VIEWS = ["local", "remote", "phone"] as const;
type View = (typeof VIEWS)[number];

const DESKTOP: Look = {
	width: 1280,
	height: 860,
	dpr: 1,
	orientation: "landscape",
	theme: BLOCKED_USAGE ? "dark" : "light",
	lang: BLOCKED_USAGE ? "ko" : language,
	device: "electron",
};
const PHONE: Look = {
	width: 390,
	height: 844,
	dpr: 3,
	orientation: "portrait",
	theme: DESKTOP.theme,
	lang: DESKTOP.lang,
};

const VIEW_LOOK: Record<View, Look> = { local: DESKTOP, remote: DESKTOP, phone: PHONE };
const VIEW_LABEL: Record<View, string> = {
	local: "This computer: B's own window",
	remote: "Paired computer: A viewing B's session",
	phone: "Phone 390×844: B's web page",
};

/** One of B's sessions as every view reaches it. */
interface HostSession {
	path: string;
	cwd: string;
}

/** What the run wrote for one surface (`parity.json`). */
interface SurfaceRecord {
	id: string;
	title: string;
	session: ParitySession;
	shots: Partial<Record<View, string>>;
	sheet?: string;
	failures: string[];
}

/** A surface the sheet can capture. */
type ParitySurface = Surface & { parity: NonNullable<Surface["parity"]> };

function paritySurfaces(): ParitySurface[] {
	const capable = SURFACES.filter(
		(surface): surface is ParitySurface => surface.parity !== undefined && surface.parity.available?.() !== false,
	);
	const only = process.env.OMP_GUI_PARITY_ONLY?.split(",").filter(Boolean);
	if (!only) return capable;
	return only.map(id => {
		const surface = capable.find(entry => entry.id === id);
		if (!surface)
			throw new Error(
				`no parity surface "${id}": ${capable.map(entry => entry.id).join(", ")} (responsive-surfaces.ts \`parity\`)`,
			);
		return surface;
	});
}

/** The three views side by side under their labels, one PNG. */
async function writeSheet(browser: Browser, surface: Surface, shots: Record<View, string>, file: string) {
	const images = await Promise.all(
		VIEWS.map(async view => ({
			view,
			src: `data:image/png;base64,${(await fs.readFile(shots[view])).toString("base64")}`,
		})),
	);
	const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
	const context = await browser.newContext({ viewport: { width: 3200, height: 1000 }, deviceScaleFactor: 1 });
	try {
		const page = await context.newPage();
		await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff;font:15px system-ui,sans-serif;color:#1f2328">
<main style="display:inline-flex;flex-direction:column;gap:12px;padding:16px">
<div><b>${html(surface.id)}</b> · ${html(surface.title)}</div>
<div style="display:flex;gap:16px;align-items:flex-start">
${images
	.map(
		image => `<figure style="margin:0;display:flex;flex-direction:column;gap:6px">
<figcaption>${html(VIEW_LABEL[image.view])}</figcaption>
<img src="${image.src}" style="height:760px;width:auto;border:1px solid #d0d7de">
</figure>`,
	)
	.join("\n")}
</div></main></body></html>`);
		await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
		await page.locator("main").screenshot({ path: file });
	} finally {
		await context.close();
	}
}

if (dir) {
	// A capture launches its own two apps on its own profiles and ports, so the order check's two captures (every
	// surface, and every surface in reverse) run side by side as two tests, each in a worker of its own.
	test.describe.configure({ mode: "parallel", retries: 0 });

	const capture = async (surfaces: readonly ParitySurface[], out: string): Promise<void> => {
		test.setTimeout(300_000 + surfaces.length * 90_000);
		await fs.mkdir(out, { recursive: true });
		const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-parity-")));
		// The composer dictation surfaces script the fake omp's speech through this file (e2e/fixture/rpc-ui.ts `voiceScript`).
		process.env.OMP_GUI_TEST_VOICE_FILE = path.join(parent, "voice.json");
		// `session-slow-start` holds the fake omp's `get_state` through this file (e2e/fixture/rpc-ui.ts `startFile`).
		process.env.OMP_GUI_TEST_START_FILE = path.join(parent, "start.json");
		let host: RemoteInstance | undefined;
		let client: RemoteInstance | undefined;
		let proxy: ServeProxy | undefined;
		const browser = await chromium.launch();
		const pageErrors: string[] = [];
		try {
			const ghBin = path.join(parent, "ghbin");
			await writeParityGh(ghBin);
			const hostProfile = await makeRemoteProfile(parent, "host", {
				language: DESKTOP.lang,
				theme: DESKTOP.theme,
				// The usage row under a reply (`reply-usage`): on here, on the paired computer and through to the phone.
				prefs: { displayPreferences: { showTokenUsage: true }, ...(BLOCKED_USAGE ? { sidebarWidth: 227 } : {}) },
				// Only the host's omp starts under the hold: its slow-start bound is short, so the banner shows within seconds.
				// B's `gh` is the stand-in above: every view's GitHub reads reach B's.
				env: {
					OMP_GUI_START_SLOW_MS: "1500",
					OMP_GUI_TEST_KEYCHAIN_WOULD_ASK: "1",
					PATH: `${ghBin}${path.delimiter}${process.env.PATH}`,
				},
			});
			await seedProject(hostProfile.project);
			const clientProfile = await makeRemoteProfile(parent, "client", {
				language: DESKTOP.lang,
				theme: DESKTOP.theme,
				port: hostProfile.port,
				prefs: { displayPreferences: { showTokenUsage: true }, ...(BLOCKED_USAGE ? { sidebarWidth: 227 } : {}) },
				env: { OMP_GUI_TEST_KEYCHAIN_WOULD_ASK: "1" },
			});
			// `settings-updates-token-dropped`: a token the keychain would not release was removed at an earlier launch, and
			// the marker it left is what Settings › Updates shows (src/main/update-auth.ts).
			if (surfaces.some(surface => surface.id === "settings-updates-token-dropped")) {
				for (const profile of [hostProfile, clientProfile])
					await fs.writeFile(path.join(profile.desktop, "update-token.dropped"), "keychain-would-ask");
			}
			host = await launchRemote(hostProfile);
			client = await launchRemote(clientProfile);
			const b = host.page;
			const a = client.page;
			await a.evaluate(() => window.omp.remote.setDeviceName("PC-A"));
			const deviceId = await connectHost(b, a, "PC-B");
			await expect
				.poll(async () => (await a.evaluate(() => window.omp.remote.getState())).hosts[0]?.state, {
					timeout: 30_000,
				})
				.toBe("online");

			// B's work: a titled session with one answered turn.
			let work: HostSession = { path: "", cwd: "" };
			const start = (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
			await b.evaluate(
				id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity work" }),
				start,
			);
			const input = b.locator("textarea").first();
			await input.fill(PARITY_WORK_PROMPT);
			await input.press("Enter");
			await expect(b.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });
			await expect
				.poll(
					async () => {
						const tab = (await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === start);
						work = { path: tab?.sessionPath ?? "", cwd: tab?.cwd ?? "" };
						return work.path;
					},
					{ timeout: 30_000 },
				)
				.not.toBe("");

			// B's phone page.
			await b.evaluate(() => window.omp.mobileWeb.command({ action: "enable" }));
			await expect
				.poll(() => b.evaluate(async () => (await window.omp.mobileWeb.getState()).phase), { timeout: 60_000 })
				.toBe("ready");
			await expect.poll(() => serveSites(hostProfile.tailscale).length, { timeout: 30_000 }).toBeGreaterThan(0);
			const site = serveSites(hostProfile.tailscale).at(-1);
			if (!site) throw new Error("B's Mobile web published no serve handler");
			proxy = await ServeProxy.start(site, REMOTE_LOGIN);
			const phoneUrl = proxy.url;
			const phone = await (
				await browser.newContext({
					...devices["Pixel 7"],
					viewport: { width: PHONE.width, height: PHONE.height },
					deviceScaleFactor: PHONE.dpr,
					colorScheme: PHONE.theme,
				})
			).newPage();
			for (const [name, page] of [
				["B", b],
				["A", a],
				["phone", phone],
			] as const)
				page.on("pageerror", error => pageErrors.push(`${name}: ${error.message}`));
			await phone.goto(`${phoneUrl}/`, { timeout: 60_000 });
			await phonePaired(phone);
			// The phone's display switches are its own (device prefs), read when each view loads its page afresh.
			await phone.evaluate(() => window.omp.prefs.set("displayPreferences.showTokenUsage", true));
			if (BLOCKED_USAGE) {
				await phone.evaluate(async () => {
					await window.omp.prefs.set("language", "ko");
					await window.omp.prefs.set("themeName", "dark");
					await window.omp.prefs.set("sidebarWidth", 227);
					localStorage.setItem("omp.sidebarWidth", "227");
				});
			}
			// B announces the new phone in a toast; the toasts are dismissed before each capture (openRow), so let it land.
			await expect
				.poll(() => b.locator('[data-toast-stack] button[aria-label="Close"]').count(), { timeout: 10_000 })
				.toBeGreaterThan(0)
				.catch(() => undefined);

			const pages: Record<View, Page> = { local: b, remote: a, phone };
			/**
			 * Close what the surface before left open and every toast (a capture is of the surface, not of what the setup
			 * announced), open `row`'s session there, and wait until it is the one shown.
			 */
			const openRow = async (page: Page, row: Locator, sessionPath: string) => {
				await page.keyboard.press("Escape");
				const close = page.locator('[data-toast-stack] button[aria-label="Close"]');
				// One click each: a dismissed toast stays in the DOM, not clickable, while it animates out.
				for (const button of await close.all()) await button.click({ timeout: 5_000 }).catch(() => undefined);
				await expect(close).toHaveCount(0, { timeout: 10_000 });
				await expect(row).toHaveCount(1, { timeout: 30_000 });
				await row.locator("button").first().click();
				await expect
					.poll(
						async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.sessionPath,
						{ timeout: 30_000 },
					)
					.toBe(sessionPath);
			};
			/** A tab of B's on a session of its own, named `title` once its omp is up. */
			const titledTab = async (title: string): Promise<string> => {
				const tabId = (await b.evaluate(cwd => window.omp.tabs.spawn({ cwd }), work.cwd))?.tabId ?? "";
				if (!tabId) throw new Error(`B opened no tab for ${title}`);
				await expect
					.poll(
						async () => (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId)?.status,
						{ timeout: 60_000 },
					)
					.toBe("ready");
				await b.evaluate(([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }), [
					tabId,
					`fixture:title:${title}`,
				] as const);
				return tabId;
			};
			/** B's sessions of answered turns, each made the first time a surface shows it, by title. */
			const answered = new Map<string, HostSession>();
			const answeredSession = async (title: string, turns: ReadonlyArray<readonly [string, string]>) => {
				const made = answered.get(title);
				if (made) return made;
				const tabId = await titledTab(title);
				let sessionPath = "";
				for (const [message, answer] of turns) {
					await b.evaluate(([id, sent]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: sent }), [
						tabId,
						message,
					] as const);
					await expect
						.poll(
							async () =>
								(sessionPath = await b.evaluate(
									async ([id, text]) => {
										const tab = (await window.omp.tabs.list()).find(entry => entry.tabId === id);
										if (tab?.status !== "ready") return "";
										const page = await window.omp.rpc.commandForTab(id, {
											type: "get_transcript_page",
											fromEnd: true,
											limit: 10,
										});
										return JSON.stringify(page.data ?? null).includes(text) ? (tab.sessionPath ?? "") : "";
									},
									[tabId, answer] as const,
								)),
							{ timeout: 30_000 },
						)
						.not.toBe("");
				}
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set(title, session);
				return session;
			};
			// The pictures' turn, the media turn, every other way a reply presents something
			// (src/renderer/dev-harness/reply-showcase.ts), then a run whose reply speaks beside its tool call.
			const replySession = () =>
				answeredSession("Parity reply", [
					["fixture reply images", "Here is the changed look."],
					["fixture reply media", "The numbers:"],
					["fixture reply components", "Footnotes link both ways."],
					["fixture narrated", "Narrated run finished."],
					["fixture turn recovered", "The tests pass now."],
					["fixture turn unfixed", "One test still fails."],
					["fixture agent-desktop", "agent-desktop run finished."],
				]);
			// A session of its own: one more turn in the reply session put its first turns past what a phone's view
			// reaches in time (10 Nov 2026).
			const steerSession = () => answeredSession("Parity steer", [["fixture steered", "Steered run finished."]]);
			/**
			 * A session of its own whose one turn a provider's limit ended (`fixture rate limit`: the wait the provider
			 * names is days away and its usage report says so too), with stock's retry switch on in its omp: B's resume
			 * rules wait for the limit (turn-resume.ts) for the rest of the run.
			 */
			const limitSession = async (): Promise<HostSession> => {
				const made = answered.get("Parity limit wait");
				if (made) return made;
				const tabId = await titledTab("Parity limit wait");
				for (const command of [
					{ type: "set_setting", path: "retry.enabled", value: true },
					{ type: "prompt", message: "fixture rate limit" },
				] as const)
					await b.evaluate(([id, sent]) => window.omp.rpc.commandForTab(id, sent), [tabId, command] as const);
				let sessionPath = "";
				await expect
					.poll(
						async () => {
							const tab = (await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId);
							sessionPath = tab?.scheduledRetry?.limit ? (tab.sessionPath ?? "") : "";
							return sessionPath;
						},
						{ timeout: 30_000 },
					)
					.not.toBe("");
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set("Parity limit wait", session);
				return session;
			};
			/**
			 * A session of its own whose omp died under four turns in a row (`fixture crash`: the fake omp exits 300 ms into
			 * the turn): B's resume rules continue the first three and offer the fourth (turn-resume.ts, the cut-off row with
			 * Continue and Dismiss), which stays for the rest of the run.
			 */
			const cutSession = async (): Promise<HostSession> => {
				const made = answered.get("Parity cut off");
				if (made) return made;
				// One tab, one session: its first turn is answered, so its file exists before the omp starts dying.
				const tabId = await titledTab("Parity cut off");
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "Parity turn 1" }),
					tabId,
				);
				let sessionPath = "";
				await expect
					.poll(
						async () =>
							(sessionPath = await b.evaluate(async id => {
								await window.omp.rpc.commandForTab(id, { type: "get_state" });
								return (await window.omp.tabs.list()).find(entry => entry.tabId === id)?.sessionPath ?? "";
							}, tabId)),
						{ timeout: 30_000 },
					)
					.not.toBe("");
				const tabOf = () =>
					b.evaluate(async id => (await window.omp.tabs.list()).find(entry => entry.tabId === id), tabId);
				for (let crash = 0; crash < 4 && (await tabOf())?.cutOff === undefined; crash++) {
					// The omp dies before it answers, so the prompt's own answer may never come.
					void b
						.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture crash" }), tabId)
						.catch(() => undefined);
					// Its omp died: the "continuing" row holds until the next omp's continuation starts (or the offer stands).
					await expect
						.poll(
							async () => {
								const tab = await tabOf();
								return tab?.resuming === true || tab?.cutOff !== undefined;
							},
							{ timeout: 30_000 },
						)
						.toBe(true);
					// The next omp is up and its continuation (or the offer) has settled.
					await expect
						.poll(
							async () => {
								const tab = await tabOf();
								return tab?.status === "ready" && tab.resuming !== true;
							},
							{ timeout: 60_000 },
						)
						.toBe(true);
				}
				await expect.poll(async () => (await tabOf())?.cutOff, { timeout: 30_000 }).toBe("crash-loop");
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set("Parity cut off", session);
				return session;
			};
			/**
			 * A long session of short turns, for the turn rail (`transcript-turn-rail*`): more turns than the rail draws
			 * ticks. The fake omp answers "Parity turn N" with "Answer to Parity turn N".
			 */
			const turnsSession = () =>
				answeredSession(
					"Parity turns",
					Array.from({ length: 44 }, (_, index): [string, string] => [
						`Parity turn ${index + 1}`,
						`Answer to Parity turn ${index + 1}`,
					]),
				);
			/**
			 * A session longer than the page a transcript opens with, for `transcript-older-history`: the fake omp's own
			 * long session (`fixture:long-session`: 250 turns of six messages, "Long session turn 000" to "Long session
			 * answer 249", written to its file at once), of which a view first reads the newest 200 messages.
			 */
			const longSession = async (): Promise<HostSession> => {
				const made = answered.get("Parity long");
				if (made) return made;
				const tabId = await titledTab("Parity long");
				const seeded = await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:long-session" }),
					tabId,
				);
				expect(seeded, "the fake omp seeds its long session").toMatchObject({ success: true });
				let sessionPath = "";
				await expect
					.poll(
						async () =>
							(sessionPath = await b.evaluate(async id => {
								// Main learns a tab's session file from a `get_state` that passes through it.
								await window.omp.rpc.commandForTab(id, { type: "get_state" });
								return (await window.omp.tabs.list()).find(entry => entry.tabId === id)?.sessionPath ?? "";
							}, tabId)),
						{ timeout: 30_000 },
					)
					.not.toBe("");
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set("Parity long", session);
				return session;
			};
			/**
			 * A session of its own whose board has every zone but Needs you (`board-strip*`): a todo list with two
			 * instructions since it changed (`fixture todo behind`), a turn that fixed a failing test (`fixture turn
			 * recovered`) and subagents left at work (`fixture:subagents`) for the rest of the run. Each view reads them
			 * from the host (`get_state`, `get_subagents`, the transcript). Nothing waits on Escape, which each view presses
			 * before it shows a session (`openRow`): it would answer a question and stop a running turn (the first capture,
			 * run 45778111707, left its turn held open, and `board-strip-open` showed it interrupted).
			 */
			const boardSession = async (): Promise<HostSession> => {
				const made = answered.get("Parity board");
				if (made) return made;
				const tabId = await titledTab("Parity board");
				for (const [message, answer] of [
					["fixture todo behind", "Local fixture reply"],
					["fixture turn recovered", "The tests pass now."],
				] as const) {
					await b.evaluate(([id, sent]) => window.omp.rpc.commandForTab(id, { type: "prompt", message: sent }), [
						tabId,
						message,
					] as const);
					await untilAnswered(b, tabId, { text: answer, after: message });
				}
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:subagents" }),
					tabId,
				);
				const sessionPath =
					(await b.evaluate(() => window.omp.tabs.list())).find(entry => entry.tabId === tabId)?.sessionPath ?? "";
				if (!sessionPath) throw new Error("the board session has no file");
				const session = { path: sessionPath, cwd: work.cwd };
				answered.set("Parity board", session);
				return session;
			};
			/** B's `session` as it is when a view shows it. */
			const hostSession = async (session: ParitySession): Promise<HostSession> =>
				session === "work"
					? work
					: session === "reply"
						? replySession()
						: session === "steer"
							? steerSession()
							: session === "advisor"
								? // A session of its own too: a turn more in the reply session shifts what its other surfaces reach.
									answeredSession("Parity advisor", [["fixture advisor note", "Advisor note delivered."]])
								: session === "ci"
									? answeredSession("Parity CI", [["fixture ci note", "Pushed main."]])
									: session === "turns"
										? turnsSession()
										: session === "long"
											? longSession()
											: session === "cut"
												? cutSession()
												: session === "stress"
													? // The harness's stress turn as one turn of a session of its own (fake omp: `STRESS_PROMPT`).
														answeredSession("Parity stress", [
															[STRESS_PROMPT, "Here is the unbroken link"],
														])
													: session === "schedule"
														? // An agent's ompdesk_schedule create of a webhook routine (`reply-schedule-card`).
															answeredSession("Parity schedule", [
																["fixture schedule card", "Webhook routine saved."],
															])
														: session === "board"
															? boardSession()
															: limitSession();
			/** Put `view` on B's `session`, with nothing left open from the surface before. */
			const show: Record<View, (session: ParitySession) => Promise<void>> = {
				local: async session => {
					const { path: sessionPath } = await hostSession(session);
					await openRow(
						b,
						b.locator(`.omp-sidebar-session-row[data-session-path=${cssString(sessionPath)}]`),
						sessionPath,
					);
				},
				remote: async session => {
					const { path: sessionPath } = await hostSession(session);
					const section = a.locator(`[data-sidebar-device="${deviceId}"]`);
					await openRow(a, section.locator(`[data-device-session=${cssString(sessionPath)}]`), sessionPath);
				},
				phone: async session => {
					// A fresh load: nothing a surface before opened survives it.
					await phone.goto(`${phoneUrl}/`, { timeout: 60_000 });
					await phonePaired(phone);
					const { path: sessionPath, cwd } = await hostSession(session);
					// The phone's tab on that file, read from the phone each time and never kept from a surface before.
					let tabId = (await phone.evaluate(() => window.omp.tabs.list())).find(
						tab => tab.sessionPath === sessionPath,
					)?.tabId;
					if (!tabId) {
						const viewed = await phone.evaluate(spawn => window.omp.tabs.spawn(spawn), { cwd, sessionPath });
						tabId = viewed?.tabId ?? undefined;
						if (!tabId) throw new Error(`the phone could not view ${session}: ${JSON.stringify(viewed)}`);
					}
					await phone.goto(`${phoneUrl}/#/open?tab=${tabId}`);
					// The route switches the page's tab after the load, so wait for it: a surface that prompts the shown tab
					// must not reach the tab the page opened on (todo-behind's phone prompt never reached the work session
					// on run 44590307837, while the views before it did).
					await expect
						.poll(
							async () => (await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId,
							{ timeout: 30_000 },
						)
						.toBe(tabId);
				},
			};

			/**
			 * B also uses A as a computer (A shares itself under "PC-A", B connects), so B's own window and its phone page
			 * list a paired computer as A's window lists B. Once, for every surface that needs it.
			 */
			let pairedBack = false;
			const pairBack = async () => {
				if (pairedBack) return;
				pairedBack = true;
				await connectHost(a, b, "PC-A");
				await expect
					.poll(
						async () =>
							(await b.evaluate(() => window.omp.remote.getState())).hosts.find(host => host.name === "PC-A")
								?.state,
						{ timeout: 30_000 },
					)
					.toBe("online");
			};

			/** B's work session opens a child on A; A also runs a session of its own, so its folded section has a count. */
			let remoteChildLeft = false;
			const leaveRemoteChild = async () => {
				remoteChildLeft = true;
				await pairBack();
				const callWork = await controlToolCaller(b, hostProfile.record, start);
				const open = await callWork("ompdesk_session_open", {
					device: "PC-A",
					folder: clientProfile.project,
					message: "Title: Parity remote child\nRun the Windows suites on the other computer",
					show: "background",
				});
				expect(open.isError, open.text).toBe(false);
				const [child] = openedSessions(open.text);
				if (!child) throw new Error(`the work session opened nothing on PC-A: ${open.text}`);
				await untilAnswered(b, child);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity remote child" }),
					child,
				);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					child,
				);
				await expect
					.poll(
						async () => (await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === child)?.status,
						{ timeout: 30_000 },
					)
					.toBe("running");
				const own =
					(await a.evaluate(project => window.omp.tabs.spawn({ cwd: project }), clientProfile.project))?.tabId ??
					"";
				if (!own) throw new Error("PC-A opened no session of its own");
				await expect
					.poll(
						async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === own)?.status,
						{ timeout: 60_000 },
					)
					.toBe("ready");
				await a.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					own,
				);
				await expect
					.poll(
						async () => (await a.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === own)?.status,
						{ timeout: 30_000 },
					)
					.toBe("running");
			};

			/**
			 * What a `hiddenRoster` surface shows, set up once before the first: B runs a second session, each view opens
			 * it (so holds a tab of it) and goes back to the work session, and only then a turn of it starts two subagents,
			 * so no view shows the session when they start. The phone's capture loads its page afresh: its tab list reads
			 * them.
			 */
			let hiddenRosterLeft = false;
			const leaveHiddenRoster = async () => {
				hiddenRosterLeft = true;
				const tabId = (await b.evaluate(cwd => window.omp.tabs.spawn({ cwd }), work.cwd))?.tabId ?? "";
				if (!tabId) throw new Error("B opened no tab for the roster session");
				const rosterTab = async () =>
					(await b.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId);
				await expect.poll(async () => (await rosterTab())?.status, { timeout: 60_000 }).toBe("ready");
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity roster" }),
					tabId,
				);
				// One answered turn gives it a file, so a row in every view.
				await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), tabId);
				let sessionPath = "";
				await expect
					.poll(async () => (sessionPath = (await rosterTab())?.sessionPath ?? ""), { timeout: 30_000 })
					.not.toBe("");
				await openRow(
					a,
					a.locator(`[data-sidebar-device="${deviceId}"] [data-device-session=${cssString(sessionPath)}]`),
					sessionPath,
				);
				const viewed = await phone.evaluate(spawn => window.omp.tabs.spawn(spawn), { cwd: work.cwd, sessionPath });
				if (!viewed?.tabId)
					throw new Error(`the phone could not view the roster session: ${JSON.stringify(viewed)}`);
				for (const view of VIEWS) await show[view]("work");
				// The fake holds "fixture running" open until `fixture:finish`.
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					tabId,
				);
				await expect.poll(async () => (await rosterTab())?.status, { timeout: 30_000 }).toBe("running");
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:subagents" }),
					tabId,
				);
			};

			/**
			 * What a `crossProject` surface shows, set up once before the first: B's work session opens "Parity
			 * cross-project" in another folder of B's (`seuoffice`), and that session's turn stays running, so its row is
			 * under its opener (a finished child is no family row) and of its own project.
			 */
			let crossProjectLeft = false;
			const leaveCrossProject = async () => {
				crossProjectLeft = true;
				const folder = path.join(parent, "seuoffice");
				await fs.mkdir(folder, { recursive: true });
				const callWork = await controlToolCaller(b, hostProfile.record, start);
				const open = await callWork("ompdesk_session_open", {
					folder,
					message: "Title: Parity cross-project\nSet the office project up",
					show: "background",
				});
				expect(open.isError, open.text).toBe(false);
				const [child] = openedSessions(open.text);
				if (!child) throw new Error(`the work session opened nothing in ${folder}: ${open.text}`);
				await untilAnswered(b, child);
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity cross-project" }),
					child,
				);
				// The fake holds "fixture running" open until `fixture:finish`.
				await b.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "fixture running" }),
					child,
				);
			};

			/**
			 * What a `folderMissing` surface shows, set up once before the first: B's session "Parity folder gone" answered
			 * one turn in `moda-office`, its tab closed and the folder was deleted. It is made from B's phone page, which
			 * every view loads afresh, so no window of B keeps a tab of it (a desktop window's own tab closed through
			 * `tabs.close` rather than its tab strip stays in that window's list). A turn of the work session afterwards
			 * makes main look at the sessions' folders again (sidebar-projects.ts `schedule`).
			 */
			let folderMissingLeft = false;
			const leaveFolderMissing = async () => {
				folderMissingLeft = true;
				const folder = path.join(parent, "moda-office");
				await fs.mkdir(folder, { recursive: true });
				const tabId = (await phone.evaluate(cwd => window.omp.tabs.spawn({ cwd }), folder))?.tabId ?? "";
				if (!tabId) throw new Error("the phone opened no tab in the folder to delete");
				const goneTab = async () =>
					(await phone.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === tabId);
				await expect.poll(async () => (await goneTab())?.status, { timeout: 60_000 }).toBe("ready");
				await phone.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Parity folder gone" }),
					tabId,
				);
				await phone.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), tabId);
				await expect.poll(async () => (await goneTab())?.sessionPath ?? "", { timeout: 30_000 }).not.toBe("");
				await untilAnswered(phone, tabId);
				expect(await phone.evaluate(id => window.omp.tabs.close(id), tabId)).toBe(true);
				await fs.rm(folder, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
				await b.evaluate(id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "hello" }), start);
				await untilAnswered(b, start, { after: "hello" });
			};

			const records: SurfaceRecord[] = [];
			for (const surface of surfaces) {
				if (surface.parity.pairedBack) await pairBack();
				if (surface.parity.remoteChild && !remoteChildLeft) await leaveRemoteChild();
				if (surface.parity.hiddenRoster && !hiddenRosterLeft) await leaveHiddenRoster();
				if (surface.parity.crossProject && !crossProjectLeft) await leaveCrossProject();
				if (surface.parity.folderMissing && !folderMissingLeft) await leaveFolderMissing();
				const record: SurfaceRecord = {
					id: surface.id,
					title: surface.title,
					session: surface.parity.session,
					shots: {},
					failures: [],
				};
				records.push(record);
				await test.step(surface.id, async () => {
					const folder = path.join(out, surface.id);
					await fs.mkdir(folder, { recursive: true });
					for (const view of VIEWS) {
						const page = pages[view];
						// One line per view, so a capture the job's timeout cuts off names where it stood (forward runs
						// 45798443670 and 45816609957 stalled about 20 minutes on a surface no output named).
						console.log(`[parity] ${new Date().toISOString().slice(11, 19)} ${surface.id} › ${view}`);
						try {
							await show[view](surface.parity.session);
							await page.locator("[data-composer-input]").first().waitFor({ state: "visible", timeout: 60_000 });
							await surface.open(page, VIEW_LOOK[view]);
							if (surface.ready)
								await page.locator(surface.ready).first().waitFor({ state: "visible", timeout: 15_000 });
							await page.waitForTimeout(surface.settle ?? 450);
							if (await crashed(page)) throw new Error("the renderer crashed (Reload interface)");
							const panel = await panelCrash(page);
							if (panel !== null) throw new Error(`a panel crashed: ${panel.slice(0, 300)}`);
							// What the surface is about is on screen, so the capture shows it and the sideways check below
							// measures it (6 Nov 2026: two views of `reply-text` captured the transcript's end instead).
							const sample = surface.parity.inView;
							if (sample) {
								const shown = page.locator(sample).first();
								if ((await shown.count()) === 0) throw new Error(`${sample} is not mounted`);
								const where = await shown.evaluate(element => {
									const scroller = element.closest(".omp-transcript-scroll");
									if (!scroller) return "outside the transcript";
									const box = element.getBoundingClientRect();
									const view = scroller.getBoundingClientRect();
									return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
										? null
										: `at ${Math.round(box.top - view.top)}..${Math.round(box.bottom - view.top)}px of a ${Math.round(view.height)}px transcript`;
								});
								if (where !== null) throw new Error(`${sample} is out of view: ${where}`);
							}
							const file = path.join(folder, `${view}.png`);
							await page.screenshot({ path: file, scale: "css", animations: "disabled" });
							record.shots[view] = file;
							// The transcript scrolls down only, in every view (a reply's picture chip spilled its path out of
							// a figure cell and gave it a horizontal scrollbar, 6 Nov 2026).
							const sideways = await page.evaluate(() =>
								[...document.querySelectorAll<HTMLElement>(".omp-transcript-scroll")]
									.filter(scroller => scroller.clientWidth > 0)
									.map(scroller => scroller.scrollWidth - scroller.clientWidth),
							);
							const extra = Math.max(0, ...sideways);
							if (extra > 1) throw new Error(`the transcript scrolls sideways by ${extra}px`);
						} catch (error) {
							// Playwright's first line says what timed out, its call log's "waiting for" line on what.
							const lines = error instanceof Error ? error.message.split("\n") : [String(error)];
							const on = lines.find(line => line.includes("waiting for"))?.trim();
							// What the view showed instead, so the failure is read from its picture and not from a second run.
							const shown = path.join(folder, `${view}-failed.png`);
							const pictured = await page
								.screenshot({ path: shown, scale: "css", animations: "disabled" })
								.then(() => true)
								.catch(() => false);
							record.failures.push(
								`${view}: ${lines[0]}${on ? ` (${on})` : ""}${pictured ? `; what it showed: ${shown}` : ""}`,
							);
						}
						try {
							await surface.parity.after?.(page);
						} catch (error) {
							const first = error instanceof Error ? error.message.split("\n")[0] : String(error);
							record.failures.push(`${view}: putting back what the surface changed: ${first}`);
						}
					}
					const { local, remote, phone: phoneShot } = record.shots;
					if (record.failures.length === 0 && local && remote && phoneShot) {
						record.sheet = path.join(folder, "sheet.png");
						await writeSheet(browser, surface, { local, remote, phone: phoneShot }, record.sheet);
					}
				});
			}
			await fs.writeFile(
				path.join(out, "parity.json"),
				`${JSON.stringify({ surfaces: records, pageErrors }, null, "\t")}\n`,
			);
			const failed = records.flatMap(record => record.failures.map(failure => `${record.id} › ${failure}`));
			expect(failed, "every surface reached in every view").toEqual([]);
		} finally {
			await browser.close().catch(() => undefined);
			await proxy?.close().catch(() => undefined);
			for (const instance of [client, host]) if (instance) await exitApp(instance.app);
			await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
		}
	};

	const sheet = "local window, paired computer's view and phone of the same session";
	if (process.env.OMP_GUI_PARITY_ORDERS === "both") {
		const all = paritySurfaces();
		test(`parity sheet, forward: ${sheet}`, () => capture(all, path.resolve(dir, "forward")));
		test(`parity sheet, reverse: ${sheet}`, () => capture([...all].reverse(), path.resolve(dir, "reverse")));
	} else test(`parity sheet: ${sheet}`, () => capture(paritySurfaces(), path.resolve(dir)));
}
