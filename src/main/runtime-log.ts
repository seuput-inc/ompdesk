import { app } from "electron";
import { appendRuntimeLogAtPath, type RuntimeLogReport, runtimeLogFile } from "./runtime-log-core";

export function runtimeLogPath(): string {
	return runtimeLogFile(app.getPath("userData"));
}

export function writeRuntimeLog(report: RuntimeLogReport, context: { windowId?: number; cwd?: string } = {}): void {
	appendRuntimeLogAtPath(runtimeLogPath(), report, {
		appVersion: app.getVersion(),
		platform: process.platform,
		pid: process.pid,
		...context,
	});
}
