/** The only routine inputs owned by main: the stock pool, the machine's tools and the owner's keystore. */
import { homedir } from "node:os";
import { type FamilySession, type FamilyTab, openerOfSessions } from "../../shared/sidebar-rows";
import { type CoreRunner, ghRunner, gitRunner, resolveBin } from "../local/git/exec";
import type { MailAccounts } from "../mail-accounts";
import type { TabActivity } from "../sidecar-pool";

type Activity = Extract<TabActivity, { type: "busy" | "idle" | "ask" }>;
interface Tab {
	sessionFile: string;
	cwd: string;
	title: string;
	root?: string;
}

export interface RoutineTabFact {
	tabId: string;
	cwd: string;
	sessionFile?: string | undefined;
	device?: string | undefined;
	openedBy?: string | undefined;
	openedBySession?: string | undefined;
}

export interface RoutinePool {
	observeTabs(observer: (activity: TabActivity) => void): () => void;
	resumeFacts(): readonly RoutineTabFact[];
	tabFacts(id: string): { title: string } | null | undefined;
}

export interface RoutineHost {
	file: string;
	ready?: Promise<void>;
	log(message: string): void;
	git(): Promise<CoreRunner>;
	github(): Promise<{ home: string; runner: CoreRunner | null }>;
	email: MailAccounts["pollAccount"];
	observe(wake: string | null, tell: (activity: Activity, tab?: Tab) => void): () => void;
	/** Production uses the native defaults. A test launch may shorten the periods. */
	timing?: Partial<
		Record<
			"githubPollMs" | "gitPollMs" | "emailPollMs" | "fileDebounceMs" | "fileMaxWaitMs" | "fileRetryMs" | "quietMs",
			number
		>
	>;
}

export function routinePorts(
	pool: RoutinePool,
	accounts: Pick<MailAccounts, "pollAccount">,
): Pick<RoutineHost, "git" | "github" | "email" | "observe"> {
	return {
		git: gitRunner,
		github: async () => {
			const bin = await resolveBin("gh");
			return { home: homedir(), runner: bin ? await ghRunner(bin) : null };
		},
		email: name => accounts.pollAccount(name),
		observe: (wake, tell) =>
			pool.observeTabs(activity => {
				if (activity.type === "busy") return tell(activity);
				if (activity.type !== "idle" && activity.type !== "ask") return;
				const facts = pool.resumeFacts();
				const tab = facts.find(fact => fact.tabId === activity.tabId);
				if (!tab?.sessionFile || tab.device !== undefined) return;
				let root: string | undefined;
				if (wake !== null) {
					const tabs: FamilyTab[] = [];
					const known: FamilySession[] = [];
					for (const fact of facts) {
						if (fact.device !== undefined || fact.sessionFile === undefined) continue;
						tabs.push({
							id: fact.tabId,
							sessionPath: fact.sessionFile,
							...(fact.openedBy === undefined ? {} : { openedBy: fact.openedBy }),
							...(fact.openedBySession === undefined ? {} : { openedBySession: fact.openedBySession }),
						});
						known.push({ path: fact.sessionFile, id: fact.sessionFile, liveTabId: fact.tabId });
					}
					if (!known.some(session => session.path === wake)) known.push({ path: wake, id: wake });
					root = openerOfSessions(tabs, known).get(tab.sessionFile);
				}
				tell(activity, {
					sessionFile: tab.sessionFile,
					cwd: tab.cwd,
					title: pool.tabFacts(tab.tabId)?.title ?? "",
					...(root === undefined ? {} : { root }),
				});
			}),
	};
}
