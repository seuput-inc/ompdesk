import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { stopCore } from "../core/process";
import { itWithFileSymlinks } from "../test-symlinks";
import { runVisualizeTool, VISUALIZE_DEFINITION, type VisualChoice, type VisualPages, VisualStore } from "./visuals";

let root: string;
let project: string;
let store: VisualStore;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-visuals-"));
	project = path.join(root, "project");
	await fs.mkdir(path.join(project, "site", "assets"), { recursive: true });
	await fs.writeFile(path.join(project, "site", "index.html"), "<title>One</title>");
	await fs.writeFile(path.join(project, "site", "assets", "app.css"), "body{}");
	await fs.writeFile(path.join(project, ".env"), "SECRET=1");
	await fs.writeFile(path.join(project, "notes.bin"), "x");
	await fs.writeFile(path.join(root, "outside.css"), "nope");
	store = new VisualStore(path.join(root, "visuals"));
});
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});
afterAll(stopCore);

const pages = (overrides: Partial<VisualPages> = {}): VisualPages => ({
	close: () => {},
	inspect: () => null,
	choose: async () => "none",
	capture: async () => null,
	flag: () => {},
	...overrides,
});

describe("VisualStore", () => {
	it("keeps a version per change of a file, serves each version's snapshot and the folder's assets", async () => {
		const first = await store.open("tab", project, { target: "site/index.html" });
		expect(first).toMatchObject({ version: 1, added: true });
		const again = await store.open("tab", project, { target: "site/index.html" });
		expect(again).toMatchObject({ version: 1, added: false });
		await fs.writeFile(path.join(project, "site", "index.html"), "<title>Two</title>");
		const second = await store.open("tab", project, { target: "./site/index.html" });
		expect(second.record.id).toBe(first.record.id);
		expect(second).toMatchObject({ version: 2, added: true });

		const id = first.record.id;
		expect(store.view(id)).toMatchObject({
			label: "index.html",
			version: 2,
			versions: [{ version: 1 }, { version: 2 }],
		});
		expect(store.view(id, 1)?.version).toBe(1);
		const v1 = store.url(id, 1);
		expect(v1).toBe(`omp-visual://v1-${id}/site/index.html`);
		expect(store.parse(v1 ?? "")).toEqual({ id, version: 1 });
		const snapshot = await store.resolve(v1 ?? "");
		expect(snapshot?.type).toBe("text/html");
		expect(await fs.readFile(snapshot?.file ?? "", "utf8")).toBe("<title>One</title>");
		expect(await fs.readFile((await store.resolve(store.url(id) ?? ""))?.file ?? "", "utf8")).toBe(
			"<title>Two</title>",
		);
		expect(await store.resolve(`omp-visual://v2-${id}/site/assets/app.css`)).toMatchObject({ type: "text/css" });
	});

	itWithFileSymlinks(
		"never serves hidden files, unknown types, paths outside the folder or symlinks out of it",
		async () => {
			const { record } = await store.open("tab", project, { target: "site/index.html" });
			const at = (relative: string) => store.resolve(`omp-visual://v1-${record.id}/${relative}`);
			expect(await at(".env")).toBeNull();
			expect(await at("notes.bin")).toBeNull();
			expect(await at("../outside.css")).toBeNull();
			expect(await at("%2E%2E/outside.css")).toBeNull();
			await fs.symlink(path.join(root, "outside.css"), path.join(project, "site", "link.css"));
			expect(await at("site/link.css")).toBeNull();
			const snapshot = path.join(root, "visuals", record.id, "v1.html");
			await fs.rm(snapshot);
			await fs.symlink(path.join(root, "outside.css"), snapshot);
			const missing = await store.serve(store.url(record.id) ?? "");
			expect(missing.status).toBe(404);
			expect(await missing.text()).toBe("Not found");
			expect(await store.resolve("omp-visual://v1-0000000000000000/site/index.html")).toBeNull();
			expect(await store.resolve("https://example.com/")).toBeNull();
		},
	);

	it("serves assets only from the entry file's folder, or the whole folder when the entry sits at its root", async () => {
		await fs.mkdir(path.join(project, "config"), { recursive: true });
		await fs.writeFile(path.join(project, "config", "credentials.json"), "{}");
		await fs.writeFile(path.join(project, "data.json"), "{}");
		await fs.writeFile(path.join(project, "site", "data.json"), "{}");
		await fs.writeFile(path.join(project, "home.html"), "<title>Home</title>");
		const site = (await store.open("tab", project, { target: "site/index.html" })).record.id;
		const at = (id: string, relative: string) => store.resolve(`omp-visual://v1-${id}/${relative}`);
		expect(await at(site, "site/data.json")).toMatchObject({ type: "application/json" });
		expect(await at(site, "site/assets/app.css")).toMatchObject({ type: "text/css" });
		// Siblings of the entry's folder stay out of reach, wherever the page asks for them.
		expect(await at(site, "data.json")).toBeNull();
		expect(await at(site, "config/credentials.json")).toBeNull();
		expect(await at(site, "site/../data.json")).toBeNull();
		const home = (await store.open("tab", project, { target: "home.html" })).record.id;
		expect(await at(home, "data.json")).toMatchObject({ type: "application/json" });
		expect(await at(home, "config/credentials.json")).toMatchObject({ type: "application/json" });
		expect(await at(home, ".env")).toBeNull();
	});

	it("limits what a visual's page can request to its own origin, on every response", async () => {
		const { record } = await store.open("tab", project, { target: "site/index.html" });
		const responses = [
			await store.serve(`omp-visual://v1-${record.id}/site/index.html`),
			await store.serve(`omp-visual://v1-${record.id}/site/assets/app.css`),
			await store.serve(`omp-visual://v1-${record.id}/.env`),
			await store.serve("omp-visual://v1-0000000000000000/site/index.html"),
		];
		expect(responses.map(response => response.status)).toEqual([200, 200, 404, 404]);
		for (const response of responses) {
			const policy = response.headers.get("Content-Security-Policy") ?? "";
			const directives = new Map(
				policy.split(";").map(part => {
					const [name = "", ...values] = part.trim().split(/\s+/);
					return [name, values] as const;
				}),
			);
			expect(directives.get("default-src")).toEqual(["'none'"]);
			expect(directives.get("connect-src")).toEqual(["'self'", "data:", "blob:"]);
			expect(directives.get("form-action")).toEqual(["'none'"]);
			expect(directives.get("frame-src")).toEqual(["'none'"]);
			expect(directives.get("object-src")).toEqual(["'none'"]);
			// No directive may allow a remote origin.
			expect(policy).not.toMatch(/https?:|\*/);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		expect(responses[0]?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(await responses[0]?.text()).toBe("<title>One</title>");
		expect(responses[1]?.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
	});

	it("points a reused visual at the target it was opened with now", async () => {
		await fs.writeFile(path.join(project, "site", "two.html"), "<title>Two</title>");
		const first = await store.open("tab", project, { target: "site/index.html", label: "Mock" });
		const moved = await store.open("tab", project, { target: "site/two.html", visual: first.record.id });
		expect(moved.record.id).toBe(first.record.id);
		expect(moved).toMatchObject({ version: 2, added: true });
		expect(moved.record.target).toBe(await fs.realpath(path.join(project, "site", "two.html")));
		expect(store.url(first.record.id)).toBe(`omp-visual://v2-${first.record.id}/site/two.html`);
		// Opening the new path again finds the same visual instead of adding a second one.
		const again = await store.open("tab", project, { target: "site/two.html" });
		expect(again.record.id).toBe(first.record.id);
		expect(again.added).toBe(false);
		expect((await store.list()).length).toBe(1);

		const web = await store.open("tab", project, { target: "https://example.com/a" });
		const next = await store.open("tab", project, { target: "https://example.com/b", visual: web.record.id });
		expect(next.record.id).toBe(web.record.id);
		expect(next.added).toBe(true);
		expect(store.url(web.record.id)).toBe("https://example.com/b");
		expect((await store.open("tab", project, { target: "https://example.com/b" })).record.id).toBe(web.record.id);
		expect((await store.list()).length).toBe(2);
	});

	it("refuses files outside the working directory and other types", async () => {
		await expect(store.open("tab", project, { target: "../outside.css" })).rejects.toThrow(/outside|shows/);
		await expect(store.open("tab", project, { target: "site/assets/app.css" })).rejects.toThrow(/shows/);
		await expect(store.open("tab", project, { target: "missing.html" })).rejects.toThrow(/No such file/);
		await expect(store.open("tab", project, {})).rejects.toThrow(/either target or html/);
	});

	it("serves the exact bytes at the file limit and keeps the snapshot when a later open is too large", async () => {
		const target = "sample.PNG";
		const file = path.join(project, target);
		const bytes = Buffer.alloc(5 * 1024 * 1024, 0xf1);
		await fs.writeFile(file, bytes);
		const { record } = await store.open("tab", project, { target });
		await fs.appendFile(file, "x");
		await expect(store.open("tab", project, { target })).rejects.toThrow("is larger than 5 MB");
		const url = store.url(record.id) ?? "";
		const response = await store.serve(url);
		expect(response.headers.get("Content-Type")).toBe("image/png");
		expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
		await fs.rm(path.join(root, "visuals", record.id, "v1.png"));
		expect((await store.serve(url)).status).toBe(404);
	});

	it("continues a pre-native history, retaining user labels and bytes across pruning and restart", async () => {
		const dir = path.join(root, "visuals");
		const id = "abcdef1234567890";
		const label = "사용자가 붙인 제목 <&>";
		const folder = path.join(dir, id);
		const html = (n: number) => `<p data-choice="한글">수정 ${n} 🌱</p>\r\n`;
		await fs.mkdir(folder, { recursive: true });
		const versions = await Promise.all(
			Array.from({ length: 20 }, async (_, index) => {
				const version = index + 1;
				const file = `v${version}.html`;
				await fs.writeFile(path.join(folder, file), html(version));
				return {
					version,
					createdAt: version,
					file,
					hash: createHash("sha256").update(html(version)).digest("hex"),
				};
			}),
		);
		const original = {
			id,
			label,
			kind: "inline",
			target: "",
			cwd: project,
			root: folder,
			entry: "index.html",
			createdAt: 1,
			updatedAt: 20,
			versions,
		};
		await fs.writeFile(path.join(dir, "history.json"), JSON.stringify([original]));
		const prior = await store.serve(`omp-visual://v20-${id}/index.html`);
		expect(await prior.text()).toBe(html(20));
		expect(await store.addToTab("tab", id)).toBe(true);
		expect(await store.open("tab", project, { label, html: html(20) })).toMatchObject({ added: false, version: 20 });
		const referenced = await store.open("other", folder, { target: "v1.html", label: "사용자가 연 파일" });
		const changed = await Promise.all([21, 22].map(n => store.open("tab", project, { visual: id, html: html(n) })));
		expect(changed.map(opened => opened.version)).toEqual([21, 22]);
		await expect(fs.stat(path.join(folder, "v2.html"))).rejects.toMatchObject({ code: "ENOENT" });
		await stopCore();
		const reopened = new VisualStore(dir);
		expect((await reopened.serve(`omp-visual://v1-${id}/index.html`)).status).toBe(404);
		expect(await fs.readFile(path.join(folder, "v1.html"), "utf8")).toBe(html(1));
		expect(await reopened.list()).toEqual([
			expect.objectContaining({ id, label, cwd: project, createdAt: 1, versions: 20 }),
			expect.objectContaining({ id: referenced.record.id, label: "사용자가 연 파일" }),
		]);
		expect(reopened.view(id, 1)?.version).toBe(22);
		expect(reopened.view(id, 3)?.versions[0]).toEqual({ version: 3, createdAt: 3 });
		for (const version of [3, 20, 21, 22]) {
			const response = await reopened.serve(reopened.url(id, version) ?? "");
			expect(await response.text()).toBe(html(version));
		}
	});

	it("keeps inline HTML by label, web addresses without versions, and history across instances", async () => {
		const inline = await store.open("tab", project, { html: "<p>a</p>", label: "Chart" });
		const inline2 = await store.open("tab", project, { html: "<p>b</p>", label: "Chart" });
		expect(inline2.record.id).toBe(inline.record.id);
		expect(inline2.version).toBe(2);
		expect(await store.resolve(`omp-visual://v2-${inline.record.id}/assets/x.css`)).toBeNull();
		const web = await store.open("tab", project, { target: "https://example.com/a" });
		expect(store.url(web.record.id)).toBe("https://example.com/a");
		expect(store.view(web.record.id)?.versions).toEqual([]);
		await expect(store.open("tab", project, { target: "javascript:alert(1)" })).rejects.toThrow();

		const reloaded = new VisualStore(path.join(root, "visuals"));
		const list = await reloaded.list();
		expect(list.map(entry => entry.label)).toEqual(["example.com", "Chart"]);
		expect(list[0]).toMatchObject({ kind: "url", versions: 1 });
		expect(reloaded.view(web.record.id, 999)).toEqual({
			id: web.record.id,
			label: "example.com",
			version: 1,
			versions: [],
		});
		expect(list[1]).toMatchObject({ kind: "inline", versions: 2 });
		// A new launch knows the visuals but no tab shows them until one is opened again.
		expect(reloaded.forTab("tab")).toEqual([]);
		expect(await reloaded.addToTab("tab", inline.record.id)).toBe(true);
		expect(reloaded.forTab("tab")).toEqual([inline.record.id]);
	});
});

describe("gui_visualize", () => {
	it("is registered with a JSON schema stock accepts", () => {
		expect(VISUALIZE_DEFINITION.name).toBe("gui_visualize");
		expect(VISUALIZE_DEFINITION.parameters).toMatchObject({ type: "object", additionalProperties: false });
	});

	it("opens and reveals, then checks, waits for a choice and closes only this tab's visuals", async () => {
		const revealed: string[] = [];
		const closed: string[] = [];
		const context = {
			tabId: "tab",
			cwd: project,
			store,
			reveal: (id: string) => revealed.push(id),
			pages: pages({
				close: id => closed.push(id),
				inspect: () => ({
					title: "One",
					url: "omp-visual://x",
					loading: false,
					problems: [{ level: "error", message: "boom", source: "app.js", line: 3 }],
				}),
				choose: async () => ({ value: "b", text: "Option B" }),
			}),
		};
		const opened = await runVisualizeTool(context, { action: "open", target: "site/index.html" });
		expect(opened.isError).toBe(false);
		const id = /visual ([0-9a-f]{16})/.exec(opened.text)?.[1] ?? "";
		expect(revealed).toEqual([id]);
		expect(opened.text).toContain("version 1");

		const check = await runVisualizeTool(context, { action: "check", visual: id });
		expect(check.text).toContain("Title: One");
		expect(check.text).toContain("- error: boom (app.js:3)");
		expect((await runVisualizeTool(context, { action: "choose", visual: id })).text).toBe(
			'The user chose "b" (Option B).',
		);
		const other = await runVisualizeTool({ ...context, tabId: "other" }, { action: "check", visual: id });
		expect(other).toEqual({ text: `No visual ${id} in this tab`, isError: true });
		expect(await runVisualizeTool(context, { action: "close", visual: id })).toEqual({
			text: `Closed visual ${id}.`,
			isError: false,
		});
		expect(closed).toEqual([id]);
		expect(store.forTab("tab")).toEqual([]);
		expect((await runVisualizeTool(context, { action: "nope" })).isError).toBe(true);
	});

	it("says why a choice could not be made", async () => {
		const opened = await runVisualizeTool(
			{ tabId: "tab", cwd: project, store, reveal: () => {}, pages: pages() },
			{ action: "open", html: "<p data-choice=a>a</p>" },
		);
		const id = /visual ([0-9a-f]{16})/.exec(opened.text)?.[1] ?? "";
		const choose = (answer: VisualChoice) =>
			runVisualizeTool(
				{ tabId: "tab", cwd: project, store, reveal: () => {}, pages: pages({ choose: async () => answer }) },
				{ action: "choose", visual: id, timeout_seconds: 10 },
			);
		expect(await choose("none")).toMatchObject({ isError: true });
		expect((await choose("agent")).text).toContain("choices count only from the user");
		expect(await choose("timeout")).toEqual({ text: "The user did not choose in time.", isError: false });
		expect((await choose("closed")).text).toContain("closed before");
	});
});
