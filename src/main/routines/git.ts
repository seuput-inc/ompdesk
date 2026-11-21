/**
 * The git trigger of a routine: every `SCHEDULE_TICK_MS` it reads where `refs/heads/<branch>` of a local repository
 * points, and when the branch moved to new commits it fires the routine with `git log --oneline old..new` (at most
 * ten lines). The first read only records the baseline, and so does the first read of a branch that did not exist
 * before (a branch made later is not "new commits"); a branch moved backwards (a reset) fires nothing.
 *
 * The baseline is kept across a relaunch (`context.mark`, `{head}`): a branch that moved while OMPdesk was closed
 * fires once with those commits on the first read after it starts. The mark is saved before the routine fires.
 *
 * The loop guard: commits made while the routine's own run goes are its own work. Nothing fires while it runs, and
 * when it ends the branch as it stands is the new baseline (`runEnded`), so a routine that commits to the branch it
 * watches never starts itself. Commits by anyone else during that run are taken with them: known and deliberate.
 */
import { SCHEDULE_TICK_MS } from "../schedules";
import { failureReporter, type RoutineSource, type SourceContext } from "./source";

export type GitHeadRead =
	| { kind: "missing"; mark: { head: null } | null }
	| { kind: "unchanged" }
	| { kind: "changed"; mark: { head: string }; from: string | null };

/** The two git reads a git trigger makes; `repo` is the repository's folder. */
export interface GitPort {
	/** Compare the branch to its persisted mark. A missing branch keeps a previously observed commit. */
	head(repo: string, branch: string, mark: unknown): Promise<GitHeadRead>;
	/**
	 * The line the routine fires with for the commits in `from..to` (`3 new commits on <branch>: …` with
	 * `git log --oneline` of the newest ten); null when there are none.
	 */
	commits(repo: string, branch: string, from: string, to: string): Promise<string | null>;
}

export interface GitSourceOptions {
	repo: string;
	branch: string;
	git: GitPort;
	context: SourceContext;
	/** How often the branch is read (default `SCHEDULE_TICK_MS`). */
	intervalMs?: number;
}

export function createGitSource(options: GitSourceOptions): RoutineSource {
	return new GitSource(options);
}

class GitSource implements RoutineSource {
	readonly #repo: string;
	readonly #branch: string;
	readonly #git: GitPort;
	readonly #context: SourceContext;
	readonly #report: (key: string, error: unknown | null) => void;
	readonly #timer: ReturnType<typeof setInterval>;
	#mark: unknown;
	/** The next read only takes the branch as the baseline: the routine's own run went since the last one. */
	#rebase = false;
	#busy = false;
	/** A read was asked for while one was going. */
	#again = false;
	#stopped = false;

	constructor(options: GitSourceOptions) {
		this.#repo = options.repo;
		this.#branch = options.branch;
		this.#git = options.git;
		this.#context = options.context;
		this.#report = failureReporter(message =>
			options.context.warn(`git ${options.repo} ${options.branch}: ${message}`),
		);
		this.#mark = options.context.mark;
		this.#timer = setInterval(() => void this.#poll(), options.intervalMs ?? SCHEDULE_TICK_MS);
		this.#timer.unref?.();
		void this.#poll();
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
	}

	runEnded(): void {
		this.#rebase = true;
		if (this.#busy) this.#again = true;
		else void this.#poll();
	}

	async #poll(): Promise<void> {
		if (this.#busy || this.#stopped) return;
		this.#busy = true;
		try {
			await this.#read();
		} catch (error) {
			if (!this.#stopped) this.#report("read", error);
		} finally {
			this.#busy = false;
			if (this.#again && !this.#stopped) {
				this.#again = false;
				void this.#poll();
			}
		}
	}

	async #read(): Promise<void> {
		if (this.#context.running()) {
			this.#rebase = true;
			return;
		}
		const read = await this.#git.head(this.#repo, this.#branch, this.#mark);
		if (this.#stopped) return;
		if (this.#context.running()) {
			this.#rebase = true;
			return;
		}
		this.#report("read", null);
		this.#report("branch", read.kind === "missing" ? new Error("the branch does not exist") : null);
		if (read.kind !== "unchanged" && read.mark) {
			this.#mark = read.mark;
			this.#context.saveMark(read.mark);
		}
		if (read.kind === "missing") return;
		if (this.#rebase) {
			this.#rebase = false;
			return;
		}
		if (read.kind !== "changed" || read.from === null) return;
		const line = await this.#git.commits(this.#repo, this.#branch, read.from, read.mark.head);
		if (this.#stopped || line === null || this.#context.running()) return;
		this.#context.fire(line);
	}
}
