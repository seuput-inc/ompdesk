// What the move run seeds as real user state in the released app, and what the new app must show afterwards.
// The conversation is a stock omp session file under the agent dir the app lists (PI_CODING_AGENT_DIR, else ~/.omp/agent:
// src/main/agent-paths.ts in v0.131.0; `sessions/<project>/<id>.jsonl`, header `{type:"session",version:3,id,timestamp,cwd}` as
// session-index.test.ts writes it). The runner is a throwaway machine, so its default agent dir is used, never a person's.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SEED_SESSION_ID = "move-seed-conversation";
export const SEED_SESSION_TITLE = "이사 검사 대화 ✓ (Electron에서 만듦)";
/** A reply language a person picks in Settings › General; `prefs.set("replyLanguage", …)` validates it (ipc.ts PREFS_SET). */
export const SEED_REPLY_LANGUAGE = "Japanese";
export const SEED_PROJECT_NAME = "move-seed-project";
/** The two messages in the seeded transcript; the user's is the title, so the sidebar row and the transcript both show it. */
export const SEED_USER_TEXT = SEED_SESSION_TITLE;
export const SEED_ASSISTANT_TEXT = "업데이트 뒤에도 이 대화가 남아야 합니다.";

export function writeSeedSession(cwd: string): string {
	const dir = join(
		process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"),
		"sessions",
		"move-seed-project",
	);
	mkdirSync(dir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const time = new Date().toISOString();
	const lines = [
		{ type: "title", v: 1, title: SEED_SESSION_TITLE, updatedAt: time },
		{ type: "session", version: 3, id: SEED_SESSION_ID, timestamp: time, cwd },
		{
			type: "message",
			id: "entry-1",
			parentId: null,
			timestamp: time,
			message: { role: "user", content: SEED_SESSION_TITLE, timestamp: Date.parse(time) },
		},
		{
			type: "message",
			id: "entry-2",
			parentId: "entry-1",
			timestamp: time,
			message: {
				role: "assistant",
				content: [{ type: "text", text: SEED_ASSISTANT_TEXT }],
				timestamp: Date.parse(time),
			},
		},
	];
	const file = join(dir, `${SEED_SESSION_ID}.jsonl`);
	writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

/** In-page: poll `window.omp.sessions.list` until the seeded conversation is listed; the row's id/title/count, or null. */
export const FIND_SEED_SESSION = `(async()=>{for(let i=0;i<120;i++){const rows=await window.omp.sessions.list("global");const row=rows.find(r=>r.id===${JSON.stringify(SEED_SESSION_ID)});if(row)return{id:row.id,title:row.title,messageCount:row.messageCount};await new Promise(r=>setTimeout(r,500))}return null})()`;
const J = JSON.stringify;
/** In-page helper: poll `find()` until it returns something truthy (at most `ms`); null on timeout. Under the WebDriver script limit. */
const UNTIL =
	"const until=async(find,ms=40000)=>{const end=Date.now()+ms;for(;;){const found=find();if(found)return found;if(Date.now()>end)return null;await new Promise(r=>setTimeout(r,250))}};";
const wrap = (body: string): string => `(async()=>{${UNTIL}${body}})()`;

/**
 * Sidebar: unfold the `move-seed-project` group (SidebarFoldButton: `button[aria-expanded]` holding the project name), find
 * the seeded row (`[data-session-path$="<id>.jsonl"]`, Sidebar.tsx rowProps), require its title, open it, then require both
 * seeded messages in the transcript (`[data-transcript-kind][data-row-key]`, ChatStream.tsx). Clicking a row also closes Settings
 * (`openSession` → `closeDestination`).
 */
export const SHOW_SEED_CONVERSATION = wrap(
	`const rowOf=()=>document.querySelector('[data-session-path$=${J(`${SEED_SESSION_ID}.jsonl`)}]');` +
		`const group=await until(()=>[...document.querySelectorAll("button[aria-expanded]")].find(b=>(b.textContent||"").includes(${J(SEED_PROJECT_NAME)})));` +
		`if(!group)return{ok:false,why:"no sidebar group named ${SEED_PROJECT_NAME}"};` +
		`if(group.getAttribute("aria-expanded")==="false")group.click();` +
		`const row=await until(rowOf);if(!row)return{ok:false,why:"the seeded row is not in the unfolded group"};` +
		`if(!(row.textContent||"").includes(${J(SEED_SESSION_TITLE)}))return{ok:false,why:"the sidebar row does not show the title: "+(row.textContent||"").slice(0,120)};` +
		`row.scrollIntoView({block:"nearest"});` +
		`const button=row.querySelector("button");if(!button)return{ok:false,why:"the seeded row has no button"};button.click();` +
		`const shown=()=>{const text=[...document.querySelectorAll("[data-transcript-kind][data-row-key]")].map(e=>e.textContent||"").join(" ");return text.includes(${J(SEED_USER_TEXT)})&&text.includes(${J(SEED_ASSISTANT_TEXT)})};` +
		`if(!await until(shown,50000))return{ok:false,why:"the transcript does not show both seeded messages"};` +
		`return{ok:true,title:true,transcript:true}`,
);

/**
 * Settings › General: the reply-language row (`#setting-gui-replyLanguage`, ReplyLanguageRow.tsx; a native `<select>` whose value
 * is the stored pref) must show the seeded value. Opened through the footer's `[data-destination="settings"]` and the nav's
 * `[data-settings-section="general"]`.
 */
export const SHOW_SETTINGS_REPLY_LANGUAGE = wrap(
	`document.querySelector('[data-destination="settings"]')?.click();` +
		`const nav=await until(()=>document.querySelector('[data-settings-section="general"]'));` +
		`if(!nav)return{ok:false,why:"Settings has no General section"};nav.click();` +
		`const select=await until(()=>{const s=document.querySelector("#setting-gui-replyLanguage select");return s&&s.value===${J(SEED_REPLY_LANGUAGE)}?s:null});` +
		`if(!select){const s=document.querySelector("#setting-gui-replyLanguage select");return{ok:false,why:"reply language shows "+(s?s.value:"no select")}}` +
		`const label=select.selectedOptions[0]?.textContent??"";if(!label)return{ok:false,why:"the select shows no label"};` +
		`document.querySelector("#setting-gui-replyLanguage").scrollIntoView({block:"center"});` +
		`return{ok:true,value:select.value,label}`,
);

/**
 * Settings › Updates: the GitHub-token row (`#settings-updates-auth`, UpdatesSection.tsx UpdateAuthRow; rendered only while a
 * token is stored) with its badge, and the page's own authInfo saying the stored token is the active source.
 */
export const SHOW_SETTINGS_UPDATE_TOKEN = wrap(
	`document.querySelector('[data-destination="settings"]')?.click();` +
		`const nav=await until(()=>document.querySelector('[data-settings-section="updates"]'));` +
		`if(!nav)return{ok:false,why:"Settings has no Updates section"};nav.click();` +
		`const row=await until(()=>document.querySelector("#settings-updates-auth"));` +
		`if(!row)return{ok:false,why:"Updates shows no GitHub token row"};` +
		`const info=await window.omp.updater.authInfo();` +
		`if(info.source!=="stored"||info.hasStoredToken!==true)return{ok:false,why:"authInfo: "+JSON.stringify(info)};` +
		`row.scrollIntoView({block:"center"});` +
		`return{ok:true,badge:(row.textContent||"").slice(0,160),source:info.source}`,
);
/** The page's text, for a failed assertion's diagnostics. */
export const PAGE_TEXT = `document.body.innerText.slice(0,1500)`;

export interface SeedShots {
	/** The released or moved app's page: evaluate an expression in it (a string of the awaitable kind above). */
	evaluate(expression: string): Promise<unknown>;
	/** Save a PNG of the window to `file`. */
	screenshot(file: string): Promise<void>;
}

async function shown(
	view: SeedShots,
	name: string,
	expression: string,
	failedFile: string,
): Promise<Record<string, unknown>> {
	const result = (await view.evaluate(expression)) as Record<string, unknown> | null;
	if (result?.ok === true) return result;
	await view.screenshot(`${failedFile}.failed.png`).catch(() => undefined);
	const text = await view.evaluate(PAGE_TEXT).catch(() => "(page text unreadable)");
	throw new Error(`${name}: ${JSON.stringify(result)}; page text: ${String(text).replace(/\s+/g, " ")}`);
}

/**
 * The three views of one page, each asserted on the page before it is shot: the seeded conversation open (title in its sidebar
 * row, both messages in the transcript), Settings on the reply language, Settings on the update token. Settings is closed
 * afterwards by opening the conversation again.
 */
export async function takeSeedShots(
	view: SeedShots,
	files: { conversation: string; language: string; token: string },
): Promise<unknown[]> {
	const taken: unknown[] = [];
	taken.push(await shown(view, "conversation", SHOW_SEED_CONVERSATION, files.conversation));
	await view.screenshot(files.conversation);
	taken.push(await shown(view, "reply language", SHOW_SETTINGS_REPLY_LANGUAGE, files.language));
	await view.screenshot(files.language);
	taken.push(await shown(view, "update token", SHOW_SETTINGS_UPDATE_TOKEN, files.token));
	await view.screenshot(files.token);
	taken.push(await shown(view, "close settings", SHOW_SEED_CONVERSATION, files.conversation));
	return taken;
}

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
