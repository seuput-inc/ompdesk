/**
 * The checkout's branches (`git_branches`), read while a picker is open: the list seen last time paints at once and the
 * read replaces it in place. Shared by the branch picker and the base picker.
 */
import { useEffect, useState } from "react";
import type { RpcGitBranch } from "../../../../shared/rpc-types";
import { errorDetail } from "../../../lib/error-detail";
import { useFocusedScope } from "../../../lib/focused-scope";
import { useT } from "../../../lib/i18n";
import { lastRead, rememberRead } from "../../../lib/last-read";
import type { TabRpc } from "../../../lib/tab-rpc";

export function useBranchList(rpc: TabRpc, open: boolean): { list: RpcGitBranch[] | null; error: string | null } {
	const t = useT();
	const { device, cwd } = useFocusedScope();
	const branchesKey = `scm:branches:${cwd}`;
	const [list, setList] = useState<RpcGitBranch[] | null>(() => lastRead<RpcGitBranch[]>(device, branchesKey) ?? null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) return;
		let active = true;
		setList(lastRead<RpcGitBranch[]>(device, branchesKey) ?? null);
		setError(null);
		void rpc
			.command({ type: "git_branches" })
			.then(response => {
				if (!active) return;
				if (!response.success) throw new Error(response.error ?? t("rpc.failed"));
				const data = response.data as RpcGitBranch[];
				setList(data);
				rememberRead(device, branchesKey, data);
			})
			.catch(cause => {
				if (active) setError(errorDetail(cause));
			});
		return () => {
			active = false;
		};
	}, [open, rpc, t, device, branchesKey]);
	return { list, error };
}
