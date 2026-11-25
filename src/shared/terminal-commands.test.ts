import { describe, expect, it } from "vitest";
import { commandInput, commandsFor, parseTerminalCommands } from "./terminal-commands";

describe("saved terminal commands", () => {
	it("keeps what reads as a command and drops the rest, ids unique", () => {
		expect(
			parseTerminalCommands([
				{ id: "a", label: " Test ", command: "bun test  \n", folder: "/w" },
				{ id: "a", label: "Again", command: "x" },
				{ id: "b", label: "", command: "x" },
				{ id: "c", label: "Empty", command: "   " },
				null,
				{ id: "d", label: "Lint", command: "bun lint", folder: "" },
			]),
		).toEqual([
			{ id: "a", label: "Test", command: "bun test", folder: "/w" },
			{ id: "d", label: "Lint", command: "bun lint" },
		]);
		expect(parseTerminalCommands("nope")).toEqual([]);
	});
	it("offers a folder's own commands first, then every project's, and runs each as typed with one Enter", () => {
		const all = parseTerminalCommands([
			{ id: "g", label: "Global", command: "ls" },
			{ id: "w", label: "Here", command: "make", folder: "/w" },
			{ id: "o", label: "Other", command: "make", folder: "/o" },
		]);
		expect(commandsFor(all, "/w").map(command => command.id)).toEqual(["w", "g"]);
		expect(commandsFor(all, undefined).map(command => command.id)).toEqual(["g"]);
		expect(commandInput("cd src\nls\n\n")).toBe("cd src\rls\r");
	});
});
