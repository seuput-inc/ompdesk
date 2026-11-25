/** Stock's dashboard, live ingest and database API run in the user's Bun. The core owns the HTTP front and paging. */
import { createInterface } from "node:readline";
import { ompModuleFile } from "./omp-package";

let stopServing = () => {};
const shutdown = () => {
	stopServing();
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// The app holds our stdin pipe open for its whole life. When it goes away
// without a clean quit (crash, force-kill, an app swap), the pipe closes and
// this server must not outlive it as an orphan, even while it is still
// starting: a start that never finishes would otherwise keep it forever.
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();

// Runtime-selected: the modules live in whichever omp install the GUI resolved.
const stats = await import(ompModuleFile("omp-stats"));
const statsDb = await import(ompModuleFile("omp-stats/db"));
const { getTimeRangeConfig } = await import(ompModuleFile("omp-stats/aggregator"));
const { statsLive } = await import(ompModuleFile("omp-stats/live"));
const cwd = process.cwd();
// The judge's module is pi-coding-agent's agent graph (~84 of the host's ~142 MB footprint, ~220 ms of its ~310 ms
// start; omp 18.14.0, macOS): stock asks for the judge only on a `/api/frustration/*` estimate or run, so it loads then.
const upstream = await stats.startServer(0, "127.0.0.1", {
	judge: async () => {
		const { openStandaloneJudge } = await import(ompModuleFile("pi-coding-agent/judgment/standalone"));
		return (await openStandaloneJudge(cwd, "stats_frustration")).judge;
	},
});
statsLive().start();

// Only the core owns stdin. Never take a statement from the HTTP request.
interface PageRead {
	range: string;
	until: number;
	limit: number;
	cursor: [number, number, number | null, number, string, number] | null;
	maxSql: string;
	countSql: string;
	idsSql: string;
}

async function records(p: PageRead) {
	const db = await statsDb.initDb();
	const cutoff = p.cursor ? p.cursor[2] : getTimeRangeConfig(p.range).cutoff;
	const maxId = p.cursor ? p.cursor[5] : db.prepare(p.maxSql).get().id;
	const bounds = [p.until, maxId, cutoff];
	const total = db.prepare(p.countSql).get(...bounds).count;
	if (p.cursor) bounds.push(p.cursor[0], p.cursor[1]);
	const ids = db.prepare(p.idsSql).all(...bounds, p.limit + 1);
	const more = ids.length > p.limit;
	if (more) ids.pop();
	// Stock keeps its row-to-MessageStats mapping private.
	return { rows: ids.map(({ id }: { id: number }) => statsDb.getMessageById(id)), total, more, cutoff, maxId };
}

stopServing = () => stats.closeDb();
createInterface({ input: process.stdin }).on("line", async line => {
	try {
		process.stdout.write(`ompdesk-stats ${JSON.stringify(await records(JSON.parse(line)))}\n`);
	} catch {
		process.stdout.write("ompdesk-stats null\n");
	}
});
console.log(`ompdesk-stats-ready ${stats.formatStatsDashboardUrl("127.0.0.1", upstream.port)}`);
