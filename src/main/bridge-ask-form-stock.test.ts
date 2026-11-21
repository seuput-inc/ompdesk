import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import type { ExtensionAskDialogQuestion, FormDataReply } from "../shared/rpc-types";
import { OMP_COMMAND, INSTALLED_OMP as omp, stopOmpDaemon, withoutAwsCredentials } from "./test-bridge-probe";

/** Real stock asks, parses the native `data` reply and returns it to the tool. No model turn is started. */

const PIXEL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const FORM = `<form>
  <p>Three logo drafts, 1*2 = <b>sizes</b> differ:</p>
  <img src="logo-a.png" alt="A: round">
  <img src="${PIXEL}" alt="B: square">
  <svg viewBox="0 0 10 10" aria-label="C: drawn"><rect width="10" height="10"/></svg>
  <fieldset>
    <legend>Logo</legend>
    <p>Which logo should ship?</p>
    <label><input type="radio" name="logo" value="a" checked> A</label>
    <label><input type="radio" name="logo" value="b"> B</label>
    <label><input type="radio" name="logo" value="c"> C</label>
  </fieldset>
  <label>Notes <input type="text" name="notes" value="none"></label>
  <label>Count <input type="number" name="count" min="2" value="3" required></label>
  <input type="hidden" name="source" value="card">
</form>`;

const PROBE = `
import { writeFileSync } from "node:fs";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { install, methods } from "./ask-form";
export default function (pi) {
 pi.on("session_start", (_event, context) => {
  setTimeout(async () => {
   try {
    const native = typeof context.ui.formDialog === "function";
    install(pi);
    const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
    const html = process.env.PROBE_FORM;
    const project = methods.project_ask_form;
    const { questions } = await project({ html });
    const answers = questions.map(q => ({
      id: q.id, selectedOptions: q.formField.checked, customInput: q.formField.initialText
    }));
    answers[0].selectedOptions = ["B"];
    const invalid = await project({ html, answers: answers.with(2, { ...answers[2], customInput: "1" }) });
    const reply = await project({ html, answers });
    writeFileSync(process.env.PROBE_PROJECTION, JSON.stringify({ native, questions, invalid, reply }));
    const result = await new AskTool({ settings: session.settings, hasUI: true }).execute("ask-1", { html }, undefined, undefined, context);
    console.error("ASK_FORM_PROBE=" + JSON.stringify(result.content));
   } catch (err) {
    console.error("ASK_FORM_PROBE_ERROR=" + String(err && err.stack || err));
   }
   process.exit(0);
  }, 200);
 });
}
`;

interface Frame {
	type: string;
	id?: string;
	method?: string;
	title?: string;
	html?: string;
	options?: string[];
	questions?: ExtensionAskDialogQuestion[];
}

interface Projection {
	native: boolean;
	questions: ExtensionAskDialogQuestion[];
	invalid: { index: number; problem: string };
	reply: FormDataReply;
}

async function askForm(): Promise<{ frames: Frame[]; text: string; projection: Projection }> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-ask-form-"));
	chmodSync(isolated, 0o700);
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: isolated,
		USERPROFILE: isolated,
		TMPDIR: isolated,
		TEMP: isolated,
		TMP: isolated,
		XDG_CACHE_HOME: isolated,
		XDG_CONFIG_HOME: isolated,
		PI_CODING_AGENT_DIR: isolated,
		PI_CONFIG_DIR: ".",
		OPENAI_API_KEY: "probe-not-a-real-key",
		PROBE_PROJECTION: join(isolated, "projected.json"),
		PROBE_FORM: FORM,
	};
	withoutAwsCredentials(env, isolated);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "ask-form-probe.ts");
		writeFileSync(extension, PROBE);
		writeFileSync(join(isolated, "config.yml"), "ask:\n  notify: off\nspeech:\n  enabled: false\n");
		const child = spawn(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				extension,
			],
			{ cwd: isolated, env, stdio: ["pipe", "pipe", "pipe"], timeout: 100_000, killSignal: "SIGKILL" },
		);
		const send = (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(frame)}\n`);
		send({ type: "set_ask_dialog", enabled: true });
		let unexpected: string | undefined;
		const frames: Frame[] = [];
		createInterface({ input: child.stdout }).on("line", line => {
			const frame = JSON.parse(line) as Frame;
			if (
				frame.type !== "extension_ui_request" ||
				!["form", "ask", "select", "input", "editor"].includes(frame.method ?? "")
			)
				return;
			if (!existsSync(join(isolated, "projected.json"))) {
				unexpected = JSON.stringify({
					method: frame.method,
					title: frame.title,
					requestedForm: frame.html === FORM,
				});
				child.kill("SIGKILL");
				return;
			}
			frames.push(frame);
			const projection: Projection = JSON.parse(readFileSync(join(isolated, "projected.json"), "utf8"));
			const answer =
				frame.method === "form"
					? projection.reply
					: frame.method === "ask"
						? { answers: frame.questions?.map((q, i) => ({ id: q.id, selectedOptions: i === 0 ? ["B"] : [] })) }
						: { cancelled: true };
			send({ type: "extension_ui_response", id: frame.id, ...answer });
		});
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += String(chunk);
		});
		await once(child, "close");
		expect(unexpected, `Dialog before the probe asked: ${unexpected}\n${stderr.slice(-2500)}`).toBeUndefined();
		const line = stderr.split("\n").find(value => value.startsWith("ASK_FORM_PROBE="));
		expect(line, stderr.slice(-2500)).toMatch(/^ASK_FORM_PROBE=/);
		const content = JSON.parse(line?.slice("ASK_FORM_PROBE=".length) ?? "[]") as Array<{ text: string }>;
		const projection: Projection = JSON.parse(readFileSync(join(isolated, "projected.json"), "utf8"));
		return { frames, text: content.map(block => block.text).join("\n"), projection };
	} finally {
		stopOmpDaemon(isolated, env);
		rmSync(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

describe.skipIf(!existsSync(omp))("an ask form on stock omp", () => {
	it("reaches the card whole, pictures above the question, and the answer comes back as the form's data", async () => {
		const { frames, text, projection } = await askForm();
		expect(frames.map(frame => frame.method)).toEqual([projection.native ? "form" : "ask"]);
		if (projection.native) expect(frames[0]?.html).toBe(FORM);
		const [logo, notes] = projection.native ? projection.questions : (frames[0]?.questions ?? []);
		expect(projection.invalid).toEqual({ index: 2, problem: "Must be at least 2" });
		expect(logo).toMatchObject({
			question: "Which logo should ship?",
			header: "Logo",
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
			recommended: 0,
		});
		// The paragraph as written (Markdown punctuation escaped), the pictures as one row, the drawing as a figure.
		expect(logo?.context).toContain("Three logo drafts\\, 1\\*2 \\= **sizes** differ\\:");
		expect(logo?.context).toContain(`![A\\: round](<logo-a.png>)\n![B\\: square](<${PIXEL}>)`);
		expect(logo?.context).toMatch(/```svg\n<svg[^\n]*aria-label="C: drawn"/);
		expect(notes).toMatchObject({ question: "Notes", options: [] });
		expect(notes?.context).toBeUndefined();
		expect(JSON.parse(text.slice(text.indexOf("{")))).toEqual({ logo: "b", notes: "none", count: 3, source: "card" });
	}, 150_000);
});
