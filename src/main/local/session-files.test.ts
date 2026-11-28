import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { DEFAULT_ROLE_MODEL_SELECTOR } from "../../shared/model-restore";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import { renameStoredSession } from "./session-files";

const id = "gui-rename";
const restore = "error: Could not restore model local/gone.";
const success = JSON.stringify({ id, type: "response", success: true });

async function fixture() {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "ompdesk-session-rename-")));
	onTestFinished(() => rm(dir, RM_TEMP));
	const file = join(dir, "stored & named.jsonl");
	const log = join(dir, "calls.jsonl");
	await writeFile(log, "");
	const bin = await writeFakeOmp(
		dir,
		`import { appendFileSync, realpathSync, unlinkSync } from "node:fs";
const args = process.argv.slice(2);
const input = await Bun.stdin.text();
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, cwd: realpathSync.native(process.cwd()), notifications: process.env.PI_NOTIFICATIONS, telemetry: process.env.OTEL_SDK_DISABLED }) + "\\n");
const file = args[args.indexOf("--session") + 1];
const replies = await Bun.file(file).json();
const reply = replies[args.includes("--model") ? 1 : 0];
if (reply.remove) unlinkSync(file);
process.stderr.write(reply.stderr ?? "");
process.stdout.write(reply.stdout ?? "");
process.exitCode = 1;`,
	);
	return {
		file,
		calls: async () =>
			(await readFile(log, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line)),
		rename: (name: string, target = file) =>
			renameStoredSession({ bin, basePath: process.env.PATH ?? "" }, target, name),
	};
}

it("sends one trimmed stock frame to EOF, retrying a missing saved model once in the temp folder", async () => {
	const { file, calls, rename } = await fixture();
	const noise = [
		"{bad gui-rename",
		JSON.stringify({ type: "response", id: "other", success: true }),
		JSON.stringify({ id, type: "event" }),
	].join("\n");
	await writeFile(file, JSON.stringify([{ stdout: noise, stderr: restore }, { stdout: success }]));
	const name = 'A\n"%PATH% & B"';
	await rename(` \ufeff${name}  `);
	const args = [
		"--mode",
		"rpc",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-lsp",
		"--no-title",
		"--session",
		file,
	];
	const common = {
		input: `${JSON.stringify({ id, type: "set_session_name", name })}\n`,
		cwd: await realpath(tmpdir()),
		notifications: "off",
		telemetry: "true",
	};
	expect(await calls()).toEqual([
		{ ...common, args },
		{ ...common, args: [...args, "--model", DEFAULT_ROLE_MODEL_SELECTOR] },
	]);
});

it.each([
	{ replies: [{ stdout: success, stderr: restore }], error: null, count: 1 },
	{
		replies: [{ stdout: JSON.stringify({ id, type: "response", success: 1, error: "denied" }), stderr: restore }],
		error: "denied",
		count: 1,
	},
	{
		replies: [{ stdout: JSON.stringify({ id, type: "response", error: 4 }) }],
		error: "Session rename failed",
		count: 1,
	},
	{
		replies: [{ stderr: "  broken\r\ntrace" }],
		error: "omp could not open the session to rename it: broken\r",
		count: 1,
	},
	{
		replies: [{ stderr: restore }, { stderr: "Could not restore model p/b" }],
		error: "omp could not open the session to rename it: Could not restore model p/b",
		count: 2,
	},
	{ replies: [{ stderr: restore, remove: true }], error: "Session file not found", count: 1 },
])("honors the stock answer without another rename ($error)", async ({ replies, error, count }) => {
	const { file, calls, rename } = await fixture();
	await writeFile(file, JSON.stringify(replies));
	if (error === null) await expect(rename("name")).resolves.toBeUndefined();
	else await expect(rename("name")).rejects.toMatchObject({ message: error });
	expect(await calls()).toHaveLength(count);
});

it("rejects an empty name, wrong extension or missing session without starting stock", async () => {
	const { file, calls, rename } = await fixture();
	await expect(rename(" \ufeff ", `${file}.txt`)).rejects.toThrow("Session name cannot be empty");
	await expect(rename("name", `${file}.JSONL`)).rejects.toThrow("Invalid session path");
	await expect(rename("name", "OMPDESK-WSL:bad.jsonl")).rejects.toThrow("Invalid session path");
	await expect(rename("name")).rejects.toThrow("Session file not found");
	await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await calls()).toEqual([]);
});
