import { describe, expect, it } from "vitest";
import { shellKindOf, shellQuote } from "./shell-quote";

describe("shellQuote", () => {
	it("types a plain path bare and quotes one a shell would split or expand, for the shell that reads it", () => {
		expect(shellQuote("/Users/me/src/a.ts", "posix")).toBe("/Users/me/src/a.ts");
		expect(shellQuote("/Users/me/My Files/it's.txt", "posix")).toBe("'/Users/me/My Files/it'\\''s.txt'");
		expect(shellQuote("C:\\Users\\me\\a.ts", "windows")).toBe("C:\\Users\\me\\a.ts");
		expect(shellQuote('C:\\My Files\\say "hi".txt', "windows")).toBe('"C:\\My Files\\say ""hi"".txt"');
	});
	it("reads cmd and PowerShell as Windows quoting and any other shell as POSIX, whatever this computer is", () => {
		expect(shellKindOf("C:\\Windows\\System32\\cmd.exe", true)).toBe("windows");
		expect(shellKindOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe", true)).toBe("windows");
		expect(shellKindOf("C:\\Program Files\\Git\\bin\\bash.exe", true)).toBe("posix");
		expect(shellKindOf("zsh", false)).toBe("posix");
		expect(shellKindOf(undefined, true)).toBe("windows");
	});
});
