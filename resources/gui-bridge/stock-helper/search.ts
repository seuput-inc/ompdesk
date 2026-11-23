import { ompModuleFile } from "../omp-package";

/** The pi-natives grep surface the Files panel's content search uses (gitignore-aware, the agent's own engine). */
interface StockGrep {
	grep(options: {
		pattern: string;
		path: string;
		glob?: string;
		ignoreCase?: boolean;
		hidden?: boolean;
		gitignore?: boolean;
		maxCount?: number;
		maxColumns?: number;
		maxCountPerFile?: number;
		timeoutMs?: number;
	}): Promise<{
		matches: { path: string; lineNumber: number; line: string; column?: number }[];
		totalMatches: number;
		filesWithMatches: number;
		limitReached?: boolean;
	}>;
}

let natives: Promise<StockGrep> | null = null;
function stockGrep(): Promise<StockGrep> {
	natives ??= (async () => {
		const stock = await import(ompModuleFile("pi-natives"));
		if (typeof stock.grep !== "function") throw new Error("Installed omp has no native grep");
		return stock as StockGrep;
	})();
	return natives;
}

export const methods: Record<string, (params: unknown) => Promise<unknown>> = {
	/** The core supplies the complete, capped pi-natives options on this request. */
	"search.text": async params => {
		const result = await (await stockGrep()).grep(params as Parameters<StockGrep["grep"]>[0]);
		return {
			matches: result.matches.map(match => ({
				path: match.path.split("\\").join("/"),
				line: match.lineNumber,
				text: match.line,
				...(match.column ? { column: match.column } : {}),
			})),
			totalMatches: result.totalMatches,
			files: result.filesWithMatches,
			limited: result.limitReached === true,
		};
	},
};
