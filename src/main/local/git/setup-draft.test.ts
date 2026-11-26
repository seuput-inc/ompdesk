import { describe, expect, it } from "vitest";
import { draftFrom } from "./setup-draft";

const repo = (files: Record<string, string>) => (relative: string) => files[relative] ?? null;
// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell variable the draft writes, matched as written
const worktree = "${OMPDESK_WORKTREE_PATH}";

describe("draftFrom", () => {
	it("Superset: setup as a list, a local config wrapping it with before and after", () => {
		const config = JSON.stringify({ setup: ["bun install", "  ", "bun run build"], teardown: "rm -rf x" });
		expect(draftFrom(repo({ ".superset/config.json": config }))).toEqual({
			source: "superset",
			file: ".superset/config.json",
			commands: ["bun install", "bun run build"],
		});
		const local = JSON.stringify({ setup: { before: "echo before", after: ["echo after"] } });
		expect(
			draftFrom(repo({ ".superset/config.json": config, ".superset/config.local.json": local }))?.commands,
		).toEqual(["echo before", "bun install", "bun run build", "echo after"]);
		const replaced = JSON.stringify({ setup: "make setup" });
		expect(draftFrom(repo({ ".superset/config.json": config, ".superset/config.local.json": replaced }))).toEqual({
			source: "superset",
			file: ".superset/config.local.json",
			commands: ["make setup"],
		});
	});

	it("Conductor: the local settings win key by key; conductor.json only without settings.toml", () => {
		const shared = '[scripts]\nsetup = "bun install"  # deps\nrun = "bun dev"\n';
		expect(draftFrom(repo({ ".conductor/settings.toml": shared }))).toEqual({
			source: "conductor",
			file: ".conductor/settings.toml",
			commands: ["bun install"],
		});
		const local = "[scripts]\nsetup = 'pnpm install'\n";
		expect(draftFrom(repo({ ".conductor/settings.toml": shared, ".conductor/settings.local.toml": local }))).toEqual({
			source: "conductor",
			file: ".conductor/settings.local.toml",
			commands: ["pnpm install"],
		});
		const legacy = JSON.stringify({ scripts: { setup: "npm ci", run: "npm start" } });
		expect(draftFrom(repo({ "conductor.json": legacy }))).toEqual({
			source: "conductor",
			file: "conductor.json",
			commands: ["npm ci"],
		});
		expect(draftFrom(repo({ ".conductor/settings.toml": "[scripts]\n", "conductor.json": legacy }))).toBeNull();
	});

	it("Codex: the [setup] script, multiline strings kept as one command", () => {
		const toml = "[setup]\nscript = '''\nbun install\nbun run build\n'''\n\n[cleanup]\nscript = \"rm -rf dist\"\n";
		expect(draftFrom(repo({ ".codex/environments/environment.toml": toml }))).toEqual({
			source: "codex",
			file: ".codex/environments/environment.toml",
			commands: ["bun install\nbun run build"],
		});
		const escaped = '[setup]\nscript = "echo \\"hi\\""\n';
		expect(draftFrom(repo({ ".codex/environments/environment.toml": escaped }))?.commands).toEqual(['echo "hi"']);
	});

	it("cmux: the first command named setup, or keyed install with setup in it", () => {
		const config = JSON.stringify({
			commands: [
				{ name: "Dev", command: "bun dev", keywords: ["run"] },
				{ name: "Bootstrap", keywords: ["install"], command: "./scripts/setup.sh" },
			],
		});
		expect(draftFrom(repo({ "cmux.json": config }))).toEqual({
			source: "cmux",
			file: "cmux.json",
			commands: ["./scripts/setup.sh"],
		});
		const named = JSON.stringify({ commands: [{ title: " Project   Setup ", command: "make deps" }] });
		expect(draftFrom(repo({ ".cmux/cmux.json": named, "cmux.json": config }))?.commands).toEqual(["make deps"]);
	});

	it("Cursor: install from environment.json with comments and trailing commas", () => {
		const config = '{\n  // the cloud machine\n  "install": "echo a,] // b",\n  "start": "x", /* boot */\n}\n';
		expect(draftFrom(repo({ ".cursor/environment.json": config }))).toEqual({
			source: "cursor",
			file: ".cursor/environment.json",
			commands: ["echo a,] // b"],
		});
	});

	it("Capy: scripts.initialize", () => {
		const config = JSON.stringify({ scripts: { initialize: ["uv sync"], refresh: "uv sync" } });
		expect(draftFrom(repo({ ".capy/setup.json": config }))).toEqual({
			source: "capy",
			file: ".capy/setup.json",
			commands: ["uv sync"],
		});
	});

	it("package manager: packageManager first, then one lockfile's manager, else npm; two managers give none", () => {
		expect(draftFrom(repo({ "package.json": '{"packageManager":"pnpm@9.1.0"}', "yarn.lock": "" }))).toEqual({
			source: "package-manager",
			file: "package.json",
			commands: ["pnpm install"],
		});
		expect(draftFrom(repo({ "package.json": "{}", "bun.lock": "" }))).toEqual({
			source: "package-manager",
			file: "bun.lock",
			commands: ["bun install"],
		});
		expect(draftFrom(repo({ "package.json": "{}" }))?.commands).toEqual(["npm install"]);
		expect(draftFrom(repo({ "package.json": "{}", "yarn.lock": "", "package-lock.json": "" }))).toBeNull();
		expect(draftFrom(repo({ "bun.lock": "" }))).toBeNull();
	});

	it("Copilot: run steps of the copilot-setup-steps job, each in a subshell; uses, if and runner-only steps skipped", () => {
		const workflow = `name: Copilot Setup Steps
on: workflow_dispatch
jobs:
  copilot-setup-steps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
      - run: npm ci
      - name: Build
        working-directory: web
        run: |
          npm run build
          echo "$GITHUB_WORKSPACE"
      - if: always()
        run: echo skipped
      - run: sudo apt-get install -y jq
      - shell: pwsh
        run: Write-Host hi
`;
		expect(draftFrom(repo({ ".github/workflows/copilot-setup-steps.yml": workflow }))).toEqual({
			source: "copilot",
			file: ".github/workflows/copilot-setup-steps.yml",
			commands: ["(\nnpm ci\n)", `(\ncd web || exit 1\nnpm run build\necho "${worktree}"\n)`],
		});
		const one = "jobs:\n  copilot-setup-steps:\n    steps:\n      - run: make deps\n";
		expect(draftFrom(repo({ ".github/workflows/copilot-setup-steps.yml": one }))?.commands).toEqual(["make deps"]);
		const duplicate = "jobs:\n  copilot-setup-steps:\n    steps:\n      - run: a\n  copilot-setup-steps: {}\n";
		expect(draftFrom(repo({ ".github/workflows/copilot-setup-steps.yml": duplicate }))).toBeNull();
	});

	it("Dev Container: creation lifecycle commands in spec order, variables rewritten, unsafe ones dropped", () => {
		const config = `{
  // "comment" with a quote
  "name": "x // not a comment",
  "postCreateCommand": { "a": "echo \${containerWorkspaceFolder}", "b": "echo \${localEnv:HOME:default}", },
  "onCreateCommand": ["npm", "ci"],
  "updateContentCommand": ["echo", "needs quoting"],
  /* host side */ "initializeCommand": "x",
}`;
		expect(draftFrom(repo({ ".devcontainer/devcontainer.json": config }))).toEqual({
			source: "devcontainer",
			file: ".devcontainer/devcontainer.json",
			commands: ["npm ci", `echo ${worktree}`],
		});
		const empty = '{ "name": "x" }';
		const other = '{ "postCreateCommand": "make" }';
		expect(draftFrom(repo({ ".devcontainer/devcontainer.json": empty, ".devcontainer.json": other }))).toBeNull();
	});

	it("takes the first provider in Orca's order: workspace tools, then the lockfile guess, then CI and containers", () => {
		const superset = JSON.stringify({ setup: "superset-setup" });
		const capy = JSON.stringify({ scripts: { initialize: "capy-setup" } });
		expect(draftFrom(repo({ ".capy/setup.json": capy, ".superset/config.json": superset }))?.source).toBe("superset");
		const devcontainer = '{ "postCreateCommand": "make" }';
		expect(
			draftFrom(repo({ ".devcontainer.json": devcontainer, "package.json": "{}", "bun.lock": "" }))?.source,
		).toBe("package-manager");
	});

	it("a config whose commands pass the field limit gives way to the next provider", () => {
		const huge = JSON.stringify({ setup: ["x".repeat(40 * 1024), "y".repeat(40 * 1024)] });
		const cursor = '{ "install": "npm ci" }';
		expect(draftFrom(repo({ ".superset/config.json": huge, ".cursor/environment.json": cursor }))).toEqual({
			source: "cursor",
			file: ".cursor/environment.json",
			commands: ["npm ci"],
		});
	});

	it("nothing usable is null", () => {
		expect(draftFrom(repo({}))).toBeNull();
		expect(draftFrom(repo({ ".superset/config.json": "{ not json", ".cursor/environment.json": "[]" }))).toBeNull();
	});
});
