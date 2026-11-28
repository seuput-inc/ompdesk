/** #51: the real dialog on Windows and its paired phone. NewBotDialog.test.tsx and new-bot-hosts.test.ts
 * cover probe failures. bot-create-remote.e2e.ts @smoke submits the template and verifies the owning computer. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { en } from "../src/renderer/locales/en";
import { ko } from "../src/renderer/locales/ko";
import { stagedShell } from "./fixture/shell-launch";
import { cssString, exitApp } from "./harness";
import {
	connectHost,
	freePort,
	launchRemote,
	linkProxy,
	makeRemoteProfile,
	type RemoteInstance,
} from "./remote-harness";
import { before, shot, shots, withPhone } from "./shipped-capture";

const wait = { timeout: 60_000 };

function profile(root: string, name: string, lang: "ko" | "en", port: number, env: Record<string, string> = {}) {
	const home = path.join(root, name);
	return makeRemoteProfile(root, name, {
		port,
		language: lang,
		theme: "light",
		env: {
			HOME: home,
			USERPROFILE: home,
			PI_CONFIG_DIR: ".",
			OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
			HERMES_HOME: path.join(home, ".hermes"),
			...env,
		},
	});
}

// The OS paints the open select outside the page screenshot. Keep its actual groups and reasons alongside it.
function optionGroups(computer: Locator) {
	return computer.locator("optgroup").evaluateAll(groups =>
		groups.map(group => ({
			label: group.getAttribute("label"),
			options: Array.from(group.querySelectorAll("option"), o => ({
				label: o.label,
				disabled: o.disabled,
				selected: o.selected,
			})),
		})),
	);
}

if (shots) {
	const out = shots;
	for (const lang of ["ko", "en"] as const)
		for (const surface of ["desktop", "phone390"] as const)
			test(`shipped captures #51 new bot ${lang} ${surface}`, async () => {
				test.setTimeout(240_000);
				const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "new-bot-")));
				const port = await freePort();
				const link = await linkProxy(port);
				let host: RemoteInstance | undefined;
				let desk: RemoteInstance | undefined;
				try {
					const [owner, client] = await Promise.all([
						profile(root, "studio", lang, port, { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" }),
						profile(root, "desk", lang, Number(link.address.split(":")[1])),
					]);
					host = await launchRemote(owner);
					desk = await launchRemote(client);
					await desk.page.evaluate(() => window.omp.remote.setDeviceName("Desk"));
					const device = await connectHost(host.page, desk.page, "Studio");
					const strings = lang === "ko" ? ko : en;
					const stem = `51-${lang}-${surface}-new-bot`;
					const capture = async (page: Page) => {
						const phone = surface === "phone390";
						const sidebar = async () => {
							if (phone && !(await page.locator("[data-drawer]").isVisible()))
								await page.getByRole("button", { name: strings["shell.openMenu"], exact: true }).click();
							return page.locator(phone ? "[data-drawer] .omp-session-sidebar" : ".omp-session-sidebar");
						};
						const dialog = page.getByRole("dialog", { name: strings["bots.new.title"], exact: true });
						const form = dialog.locator("[data-new-bot]");
						const computer = form.getByRole("combobox", { name: strings["bots.new.computer"], exact: true });
						const name = form.getByRole("textbox", { name: strings["bots.new.name"], exact: true });
						const purpose = form.getByRole("textbox", { name: strings["bots.new.purpose"], exact: true });
						const model = form.getByRole("button", { name: strings["bots.new.model"], exact: true });
						const cancel = dialog.getByRole("button", { name: strings["common.cancel"], exact: true });
						const oldLocation =
							lang === "ko"
								? "이 컴퓨터의 자기 폴더에서 실행돼요."
								: "It runs on this computer, in its own folder.";
						const create = dialog.getByRole("button", { name: strings["bots.new.create"], exact: true });
						const blank = page
							.locator("[data-bots-page]")
							.getByRole("button", { name: strings["bots.add.new"], exact: true });

						// Hand to bot needs an open, indexed session in this viewer, not merely one in the desktop window.
						const title = lang === "ko" ? "프로젝트 요약" : "Project summary";
						const tab = phone
							? await page.evaluate(
									async cwd => (await window.omp.tabs.spawn({ cwd, kind: "agent" }))?.tabId,
									client.project,
								)
							: await page.evaluate(async () => (await window.omp.tabs.list()).find(t => t.active)?.tabId);
						if (!tab) throw new Error("No local session for Hand to bot");
						await expect
							.poll(
								() =>
									page.evaluate(
										async id => (await window.omp.tabs.list()).find(t => t.tabId === id)?.status,
										tab,
									),
								wait,
							)
							.toBe("ready");
						await page.evaluate(
							async ({ id, title }) => {
								await window.omp.rpc.commandForTab(id, { type: "bash", command: `fixture:title:${title}` });
								await window.omp.rpc.commandForTab(id, { type: "prompt", message: title });
							},
							{ id: tab, title },
						);
						const row = (await sidebar())
							.locator(".omp-sidebar-session-row:not([data-live])")
							.filter({ hasText: title });
						await expect(row).toBeVisible(wait);
						if (!phone) await row.hover();
						await row.locator("[data-sidebar-row-menu]").click();
						await page.getByRole("menuitem", { name: strings["bots.hand.menu"], exact: true }).click();
						const hand = page.getByRole("dialog").filter({ has: page.locator("[data-hand-to-bot]") });
						await expect(hand.getByRole("radio")).toBeChecked();
						await hand.getByRole("button", { name: strings["bots.hand.newBot"], exact: true }).click();
						await expect(dialog).toContainText(strings["bots.new.forHandOver"].replace("{title}", title));
						if (before) await expect(form.getByText(oldLocation, { exact: true })).toBeVisible();
						else {
							await expect(computer).toBeDisabled();
							await expect(computer.locator("option")).toHaveCount(1);
							await expect(computer).toHaveValue("");
							await expect(form.locator("[data-new-bot-folder]")).toContainText("Desk");
						}
						await shot(page, `${stem}-handoff`);
						await cancel.click();
						await (await sidebar()).locator("[data-sidebar-bots-open]").click();
						await blank.click();
						await expect(name).toHaveValue("");
						await expect(purpose).toHaveValue("");
						await expect(model).toHaveText(strings["bots.new.modelDefault"]);
						await expect(create).toBeEnabled();
						const remote = computer.locator(`option[value=${cssString(device)}]`);
						if (before) {
							await expect(form.getByRole("combobox")).toHaveCount(0);
							await expect(form.getByText(oldLocation, { exact: true })).toBeVisible();
						} else {
							await expect(remote).toBeEnabled(wait);
							await expect(computer).toHaveValue("");
							const ready = strings["bots.new.host.ready"];
							await expect(computer.locator("option:checked")).toHaveText(`Desk · Windows · ${ready}`);
							await expect(remote).toHaveText(new RegExp(`Studio.*${ready}$`));
							await expect(form.locator("[data-new-bot-folder]")).toContainText("Desk");
						}
						await expect(form.locator("[data-bot-import-nudge]")).toHaveCount(0);
						await page.evaluate(() => document.fonts.ready.then(() => undefined));
						await shot(page, `${stem}-empty`);
						const size = await form.evaluate(el => {
							const sheet = el.closest('[role="dialog"]');
							if (!sheet) throw new Error("No dialog around the form");
							return {
								viewportCssPx: { width: innerWidth, height: innerHeight },
								formHeightCssPx: el.getBoundingClientRect().height,
								dialogHeightCssPx: sheet.getBoundingClientRect().height,
							};
						});
						expect(size.formHeightCssPx).toBeGreaterThan(0);
						if (phone) expect(size.viewportCssPx.width).toBe(390);
						const jsonStem = path.join(out, `${before ? "before" : "after"}-${stem}`);
						await fs.writeFile(`${jsonStem}-empty.json`, `${JSON.stringify(size, null, 2)}\n`);
						if (!before) {
							const list = page.getByRole("listbox");
							const opus = list.getByRole("option", { name: /Opus 4\.1/ });
							await model.click();
							await expect(list.getByRole("option", { name: /Local fixture/ })).toBeVisible(wait);
							await expect(opus).toHaveCount(0);
							await shot(page, `${stem}-local-models`);
							await page.keyboard.press("Escape");
							await computer.selectOption(device);
							await model.click();
							await expect(opus).toBeVisible(wait);
							await shot(page, `${stem}-host-models`);
							await opus.click();
						}
						await dialog.getByRole("button", { name: strings["bots.new.templates"], exact: true }).click();
						await page.locator('[data-bot-template="dependency-updates"]').click();
						await page.locator("[data-bot-template-use]").click();
						await expect(name).not.toHaveValue("");
						await expect(form.getByRole("checkbox", { name: "dependency-upgrade" })).toBeChecked();
						if (!before) {
							await expect(computer).toHaveValue(device);
							await expect(model).toContainText(/opus[ -]4[.-]1/i);
							const routineNote = strings["bots.new.activateRoutines"].replace("{host}", "Studio");
							await expect(form.getByText(routineNote)).toBeVisible();
							await expect(form.locator("[data-new-bot-folder]")).toContainText("Studio");
						}
						await shot(page, `${stem}-template`);
						await link.drop();
						if (before) {
							await expect
								.poll(
									() =>
										page.evaluate(
											async id =>
												(await window.omp.remote.getState()).hosts.find(h => h.deviceId === id)?.state,
											device,
										),
									wait,
								)
								.toBe("offline");
							await expect(form.getByText(oldLocation, { exact: true })).toBeVisible();
							await expect(create).toBeEnabled();
						} else {
							await expect(remote).toHaveText(new RegExp(`Studio.*${strings["bots.new.host.offline"]}`), wait);
							await expect(remote).toBeDisabled();
							await expect(computer).toHaveValue(device);
							await expect(create).toBeDisabled();
							await expect(model).toBeDisabled();
							await expect(computer.locator('option[value=""]')).toBeEnabled(wait);
						}
						const groups = await optionGroups(computer);
						expect(groups.map(group => group.label)).toEqual(
							before ? [] : [strings["bots.new.group.ready"], strings["bots.new.group.unavailable"]],
						);
						await shot(page, `${stem}-unavailable`);
						await fs.writeFile(`${jsonStem}-unavailable.json`, `${JSON.stringify(groups, null, 2)}\n`);
						await cancel.click();
						// Discover one synthetic source only after measuring the blank form, so no nudge inflates its height.
						const source = path.join(client.root, ".openclaw", "workspace");
						await fs.mkdir(source, { recursive: true });
						await fs.writeFile(path.join(source, "IDENTITY.md"), "Name: Atlas\n");
						await blank.click();
						await form
							.locator("[data-bot-import-nudge]")
							.getByRole("button", { name: strings["bots.import.nudgeIt"], exact: true })
							.click();
						const imported = page.locator("[data-bot-import]");
						await expect(imported.getByRole("radio", { name: /Atlas/ })).toBeChecked();
						await expect(
							imported.getByRole("textbox", { name: strings["bots.import.name"], exact: true }),
						).toHaveValue("Atlas");
						await expect(imported.getByText(strings["bots.import.keysStay"], { exact: true })).toBeVisible();
						await expect(imported.getByRole("combobox")).toHaveCount(0);
						await shot(page, `${stem}-import`);
					};
					if (surface === "desktop") await capture(desk.page);
					else await withPhone(desk.page, client.tailscale, capture, lang);
				} finally {
					await link.close();
					if (desk) await exitApp(desk.app);
					if (host) await exitApp(host.app);
					await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
				}
			});

	if (!before)
		test("shipped captures #51 new bot ko desktop legacy host", async () => {
			test.setTimeout(180_000);
			const legacy = process.env.OMP_GUI_SHIPPED_LEGACY;
			if (!legacy) throw new Error("Set OMP_GUI_SHIPPED_LEGACY to the built v0.152.0 checkout");
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "new-bot-legacy-")));
			let host: RemoteInstance | undefined;
			let desk: RemoteInstance | undefined;
			try {
				const port = await freePort();
				const [old, current] = await Promise.all([
					profile(root, "studio", "ko", port, {
						OMP_GUI_E2E_OUT: path.resolve(legacy, "out"),
						OMP_GUI_E2E_SHELL: stagedShell("win32", "x64", legacy),
						OMPDESK_NODE: path.resolve(legacy, "resources/node/win32-x64/node.exe"),
					}),
					profile(root, "desk", "ko", port),
				]);
				host = await launchRemote(old);
				desk = await launchRemote(current);
				const page = desk.page;
				const [hostVersion, clientVersion] = await Promise.all(
					[host.page, page].map(viewer =>
						viewer.evaluate(async () => (await window.omp.system.info()).appVersion),
					),
				);
				expect([hostVersion, clientVersion]).toEqual(["0.152.0", "0.153.0"]);
				await page.evaluate(() => window.omp.remote.setDeviceName("Desk"));
				const device = await connectHost(host.page, page, "Studio");
				// New bot from a bot owned by Studio selects Studio even when it cannot create another.
				const made = await host.page.evaluate(() => window.omp.bots.command({ action: "create", name: "Archive" }));
				const bot = made.bots.find(bot => bot.name === "Archive");
				if (!bot) throw new Error("The legacy host did not create Archive");
				await page.locator("[data-sidebar-bots-open]").click();
				await page.locator(`[data-bots-page-row=${cssString(bot.id)}]`).click();
				const newBot = { name: ko["bots.add.new"], exact: true };
				await page.locator(".omp-page-header").getByRole("button", newBot).click();
				await page.getByRole("menuitem", newBot).click();
				const dialog = page.getByRole("dialog", { name: ko["bots.new.title"], exact: true });
				const computer = dialog.getByRole("combobox", { name: ko["bots.new.computer"], exact: true });
				const oldOption = computer.locator(`option[value=${cssString(device)}]`);
				await expect(computer).toHaveValue(device);
				await expect(oldOption).toHaveText(/Studio.*OMPdesk 업데이트 필요$/, wait);
				await expect(oldOption).toBeDisabled();
				await expect(computer.locator('option[value=""]')).toBeEnabled(wait);
				await expect(dialog.getByRole("button", { name: ko["bots.new.create"], exact: true })).toBeDisabled();
				const groups = await optionGroups(computer);
				expect(groups.map(group => group.label)).toEqual([
					ko["bots.new.group.ready"],
					ko["bots.new.group.unavailable"],
				]);
				const stem = "51-ko-desktop-new-bot-legacy-host";
				await shot(page, stem);
				await fs.writeFile(
					path.join(out, `after-${stem}.json`),
					`${JSON.stringify({ hostVersion, clientVersion, groups }, null, 2)}\n`,
				);
			} finally {
				if (desk) await exitApp(desk.app);
				if (host) await exitApp(host.app);
				await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			}
		});
}
