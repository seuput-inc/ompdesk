import { codedError } from "./ipc-error-codes";

/** Includes malformed reserved keys: only the core parses them; none may be opened as a file. */
export function isWslSessionRef(value: string): boolean {
	return /^ompdesk-wsl:/i.test(value);
}

export function requireFileSession(value: string): void {
	if (isWslSessionRef(value)) throw codedError("wsl_session_unavailable", "WSL session is not a stock session file");
}
