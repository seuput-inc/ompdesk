/**
 * The files a shell glob of a claim matches on disk now (`CheckoutHost.expand`, checkout-peers-core.ts): a formatter on
 * a folder (`cargo fmt --all`, `biome --write src`) is read as rewriting `<folder>/**`, and the claim takes what that
 * matches before the command runs. Without what git ignores: a formatter never rewrites build output, and
 * `cargo fmt --all` claimed 1,135 files of `native/ompdesk/target/debug` (Mac mini, 11 Nov 2026), which protected
 * nothing and filled the claims journal.
 */
import { spawnSync } from "node:child_process";

export function expandGlob(glob: string): string[] {
	const cut = glob.search(/[*?[]/);
	const base = glob.slice(0, glob.lastIndexOf("/", cut)) || "/";
	try {
		const files = [
			...new Bun.Glob(glob.slice(base.length + 1)).scanSync({
				cwd: base,
				absolute: true,
				onlyFiles: true,
				dot: true,
			}),
		].map(file => file.replaceAll("\\", "/"));
		return withoutIgnored(base, files);
	} catch {
		return [];
	}
}

/**
 * `files` (absolute, under `base`) without those git ignores: one `git check-ignore --stdin -z` for them all. A
 * tracked file is never ignored. All of `files` when git is missing, fails or `base` is in no repository.
 */
export function withoutIgnored(base: string, files: string[]): string[] {
	if (files.length === 0) return files;
	// Never another repository's selectors (a hook or `git bisect run` exports GIT_DIR): the folder decides.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	const run = spawnSync("git", ["-C", base, "check-ignore", "--stdin", "-z"], {
		input: `${files.join("\0")}\0`,
		env,
		maxBuffer: 256 * 1024 * 1024,
		timeout: 10_000,
		windowsHide: true,
	});
	// 0: some are ignored; 1: none is; anything else (128: no repository, a path outside it) is a failure.
	if (run.status !== 0) return files;
	const ignored = new Set(run.stdout.toString("utf8").split("\0"));
	return files.filter(file => !ignored.has(file));
}
