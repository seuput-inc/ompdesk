import * as fs from "node:fs/promises";
import * as path from "node:path";
import { StockHelper } from "../stock-helper";

/** The real terminal worker and scrollback with a PTY that records launches and kills instead of starting shells. */
export async function terminalTestHelper(dir: string): Promise<StockHelper> {
	const bridge = path.resolve("resources/gui-bridge");
	const natives = path.join(dir, "node_modules/@oh-my-pi/pi-natives");
	await fs.mkdir(natives, { recursive: true });
	await fs.writeFile(path.join(dir, "package.json"), "{}");
	await fs.writeFile(path.join(natives, "package.json"), JSON.stringify({ main: "index.js" }));
	await fs.writeFile(
		path.join(natives, "index.js"),
		`import { appendFileSync } from "node:fs";
export class PtySession {
	startArgv({ application, args, cwd, cols, rows, env }, emit) {
		this.emit = emit;
		if (env.STOCK_TEST_LAUNCH_LOG) {
			appendFileSync(env.STOCK_TEST_LAUNCH_LOG, JSON.stringify({ application, args, cwd, cols, rows }) + "\\n");
		}
		return new Promise(() => {});
	}
	write(text) { this.emit(null, text); }
	resize() {}
	kill() { appendFileSync(${JSON.stringify(path.join(dir, "kills"))}, "x"); }
}`,
	);
	return new StockHelper(bridge, {
		launch: async () => ({
			bin: "bun",
			args: [path.join(bridge, "stock-helper/host.ts"), "terminals"],
			env: {
				...process.env,
				OMP_PACKAGE_ROOT: dir,
				[process.platform === "win32" ? "ComSpec" : "SHELL"]: path.join(dir, "worker-default"),
			},
		}),
	});
}
