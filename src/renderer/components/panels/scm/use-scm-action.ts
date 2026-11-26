/**
 * One source-control mutation at a time: runs the command on the tab's
 * checkout, keeps which action is busy, toasts a failure in the UI language
 * (the typed `code` maps to `ipcError.*`), reports a stop on conflicts, and
 * reloads the panel afterwards either way. A failed commit, push, pull, merge
 * or replay offers to hand the failure to this session's agent (Orca's "Fix with AI").
 */
import { useCallback, useRef, useState } from "react";
import type { RpcCommand } from "../../../../shared/rpc-types";
import { handToTab } from "../../../lib/composer-handoff";
import { errorDetail } from "../../../lib/error-detail";
import { fixableGitAction, fixGitFailurePrompt } from "../../../lib/fix-prompts";
import { useFocusedScope } from "../../../lib/focused-scope";
import { useT } from "../../../lib/i18n";
import type { TabRpc } from "../../../lib/tab-rpc";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toast, toastError } from "../../../stores/toast";

export interface ScmRunOptions {
	/** Toast title when the command fails. */
	failure: string;
	/** Toast title when it succeeds; none by default (the panel itself shows the result). */
	success?: string;
}

export interface ScmRunner {
	/** Key of the running action, or null. */
	busy: string | null;
	/** Resolves with the response data, or undefined when it failed (already toasted). */
	run: <T = unknown>(key: string, command: RpcCommand, options: ScmRunOptions) => Promise<T | undefined>;
}

export function useScmAction(rpc: TabRpc, onSettled: () => void): ScmRunner {
	const t = useT();
	const tabId = useRuntimeTabId();
	const { cwd } = useFocusedScope();
	const [busy, setBusy] = useState<string | null>(null);
	const running = useRef(false);
	const run = useCallback(
		async <T>(key: string, command: RpcCommand, options: ScmRunOptions): Promise<T | undefined> => {
			const fail = (error: unknown) => {
				const action = fixableGitAction(command);
				const output = errorDetail(error);
				toastError({
					title: options.failure,
					error,
					...(action && tabId && output
						? {
								// Long enough to read the failure and press the action.
								durationMs: 15_000,
								action: {
									label: t("fixWithAgent.ask"),
									run: () =>
										handToTab(tabId, { text: fixGitFailurePrompt({ action, output, cwd }), mode: "prepend" }),
								},
							}
						: {}),
				});
			};
			if (running.current) return undefined;
			running.current = true;
			setBusy(key);
			try {
				const response = await rpc.command(command);
				if (!response.success) {
					fail(response);
					return undefined;
				}
				const data = response.data as T;
				const conflicts =
					data && typeof data === "object" && "conflicts" in data && typeof data.conflicts === "number"
						? data.conflicts
						: 0;
				if (conflicts > 0) {
					toast({ variant: "warning", message: t("scm.stoppedOnConflicts", { count: conflicts }) });
				} else if (options.success) {
					toast({ variant: "success", message: options.success });
				}
				return data;
			} catch (error) {
				fail(error);
				return undefined;
			} finally {
				running.current = false;
				setBusy(null);
				onSettled();
			}
		},
		[rpc, onSettled, t, tabId, cwd],
	);
	return { busy, run };
}
