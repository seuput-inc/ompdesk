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
				content: [{ type: "text", text: "업데이트 뒤에도 이 대화가 남아야 합니다." }],
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
/** In-page, best effort: open the seeded conversation by clicking the smallest element that shows its title. */
export const OPEN_SEED_SESSION = `(()=>{const t=${JSON.stringify(SEED_SESSION_TITLE)};const hits=[...document.querySelectorAll("body *")].filter(e=>e.children.length===0&&(e.textContent||"").includes(t));if(!hits[0])return false;hits[0].click();return true})()`;

export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
