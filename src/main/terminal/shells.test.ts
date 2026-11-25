import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { stopCore } from "../core/process";
import { detectShells } from "./shells";

afterAll(stopCore);

describe("terminal shells", () => {
	it.skipIf(process.platform === "win32")(
		"lists the login shell first, then /etc/shells entries that exist, once each",
		async () => {
			let listed = "";
			try {
				listed = readFileSync("/etc/shells", "utf8");
			} catch {
				// A host without /etc/shells still offers its installed fallback shells.
			}
			const paths = [
				process.env.SHELL,
				...listed
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.startsWith("/")),
				"/bin/zsh",
				"/bin/bash",
			];
			const seen = new Set<string>();
			const expected = paths.flatMap(file => {
				if (!file || !existsSync(file) || seen.has(file.toLowerCase())) return [];
				seen.add(file.toLowerCase());
				return [{ path: file, name: path.posix.basename(file), args: ["-l"] }];
			});
			expect(await detectShells()).toEqual(expected);
		},
	);

	it.skipIf(process.platform !== "win32")(
		"offers Command Prompt first on Windows, then PowerShell, PowerShell 7 and Git Bash where installed",
		async () => {
			const root = process.env.SystemRoot ?? "C:\\Windows";
			const programs = process.env.ProgramFiles ?? "C:\\Program Files";
			const local = process.env.LOCALAPPDATA;
			const candidates = [
				{ path: process.env.ComSpec ?? path.join(root, "System32/cmd.exe"), name: "Command Prompt", args: [] },
				{
					path: path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"),
					name: "Windows PowerShell",
					args: ["-NoLogo"],
				},
				{ path: path.join(programs, "PowerShell/7/pwsh.exe"), name: "PowerShell 7", args: ["-NoLogo"] },
				{ path: path.join(programs, "Git/bin/bash.exe"), name: "Git Bash", args: ["--login", "-i"] },
				{
					path: local && path.join(local, "ompdesk/tools/git/bin/bash.exe"),
					name: "Git Bash",
					args: ["--login", "-i"],
				},
			];
			const seen = new Set<string>();
			const expected = candidates.filter(({ path: file }) => {
				if (!file || !existsSync(file) || seen.has(file.toLowerCase())) return false;
				seen.add(file.toLowerCase());
				return true;
			});
			expect(await detectShells()).toEqual(expected);
		},
	);
});
