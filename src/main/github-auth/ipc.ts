/**
 * GitHub sign-in IPC and the production wiring of GithubAuthService: gh and git
 * from the spawn PATH (the user's installs, then the managed tools directory),
 * the login PTY in the stock helper. No handler takes a command or a path from
 * the renderer; a switch accepts only a login gh itself listed.
 */
import { homedir } from "node:os";
import type { GithubAuthState } from "../../shared/github-auth";
import { CorePort } from "../core/ports";
import { core } from "../core/process";
import { ghRunner, resolveBin } from "../local/git/exec";
import { appleDeveloperDir } from "../setup/apple-git";
import { spawnPath } from "../shell-env";
import type { IpcRegistry } from "../web/ipc-registry";
import { stockPtyLauncher } from "./pty";
import { type GithubAuthDeps, GithubAuthService } from "./service";

/** gh's browser launcher during sign-in: exits 0 and ignores the URL; the renderer opens the page itself. */
const NO_OP_BROWSER = process.platform === "win32" ? "cmd /c exit 0" : "true";

/**
 * git, unless it is macOS's /usr/bin/git stub without the Command Line Tools:
 * running that opens Apple's install dialog (same check as setup's detectGit).
 */
async function usableGit(): Promise<string | null> {
	const git = await resolveBin("git");
	if (process.platform !== "darwin" || git !== "/usr/bin/git") return git;
	return (await appleDeveloperDir(process.env, 5000)) === null ? null : git;
}

async function loginEnv(): Promise<Record<string, string>> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	Object.assign(env, {
		PATH: await spawnPath(),
		TERM: "xterm-256color",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_BROWSER: NO_OP_BROWSER,
		BROWSER: NO_OP_BROWSER,
	});
	return env;
}

/** Machine setup's gh item, for a sign-in that finds gh missing (the core's `tools` instance, `tools/client.ts`). */
export type GithubInstallHooks = Pick<GithubAuthDeps, "installGh" | "cancelGhInstall">;

export function createGithubAuthService(
	onState: (state: GithubAuthState) => void,
	install: GithubInstallHooks,
): GithubAuthService {
	return new GithubAuthService({
		resolveGh: () => resolveBin("gh"),
		resolveGit: usableGit,
		...install,
		runner: ghRunner,
		pty: stockPtyLauncher,
		loginEnv,
		home: homedir(),
		onState,
	});
}

export function registerGithubAuthIpc(_ipc: IpcRegistry, service: GithubAuthService): void {
	// `github-auth:*` channels route directly from tauri-shell to ompdesk-core (`crates/core/src/gh/auth.rs`).
	const port = new CorePort({
		refresh: ({ force }: { force?: boolean }) => service.refresh(force === true),
		startLogin: ({ scopes }: { scopes?: string | null }) =>
			service.startLogin(scopes === "project" ? "project" : undefined),
		openLogin: () => service.openLogin(),
		cancelLogin: () => service.cancelLogin(),
		logout: () => service.logout(),
		switchAccount: ({ login, hasLogin }: { login?: unknown; hasLogin?: boolean }) =>
			service.switchAccount(hasLogin ? login : undefined),
		fillIdentity: () => service.fillIdentity(),
		productStar: ({ star }: { star?: boolean }) => service.productStar(star === true),
	});
	const connect = () => {
		void core()
			.call("gh.authPort", { port: port.id })
			.catch(() => {});
	};
	connect();
	core().on("ready", connect);
}
