import type { TerminalShell } from "../../shared/terminal-types";
import { core } from "../core/process";

export async function detectShells(): Promise<TerminalShell[]> {
	return (await core().call<TerminalShell[]>("terminal.shells")).result;
}
