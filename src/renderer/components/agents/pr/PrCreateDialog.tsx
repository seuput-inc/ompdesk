/**
 * Create pull request (Dialog md, opened from Agents › Pull requests):
 * title/body form with an AI draft button that fills both fields from the
 * head branch's commits + diffstat (pr_draft, user-editable after), a draft
 * checkbox (applied on submit), and pr_create on submit. The head branch
 * reads from the active tab's live git status; the base is picked from the
 * checkout's branches and starts on the repo's default branch. The body
 * starts from the repository's pull request template when it has one.
 */

import { Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { RpcGitBranch, RpcPrCreateResult, RpcPrDraftResult } from "../../../../shared/rpc-types";
import { useGitStatus } from "../../../hooks/use-git-status";
import { github } from "../../../lib/github";
import { uploadGithubImage } from "../../../lib/github-image";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { useTabRpc } from "../../../lib/tab-rpc";
import { usePrCenterStore } from "../../../stores/pr-center";
import { useSessionStore } from "../../../stores/session";
import { toast, toastError } from "../../../stores/toast";
import { Button, Checkbox, Input, MarkdownComposer, Modal, Select } from "../../common";
import { useAssignable } from "./PrPeople";

/** Branch names a pull request can target: local ones and remote-tracking ones without their remote, once each. */
export function baseChoices(branches: readonly RpcGitBranch[], head: string | undefined, base: string | undefined) {
	const names = new Set<string>();
	if (base) names.add(base);
	for (const branch of branches) {
		const name = branch.remote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
		if (name && name !== "HEAD" && name !== head) names.add(name);
	}
	return [...names];
}

export function PrCreateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
	const tabRpc = useTabRpc();
	const t = useT();
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	const repo = usePrCenterStore(state => state.repo);
	const { status: git } = useGitStatus();
	const mentions = useAssignable({});
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [draft, setDraft] = useState(true);
	const [drafting, setDrafting] = useState(false);
	const [creating, setCreating] = useState(false);
	const [branches, setBranches] = useState<RpcGitBranch[]>([]);
	const [picked, setPicked] = useState<string | null>(null);
	const formId = useId();

	useEffect(() => {
		if (!open) return;
		setTitle("");
		setBody("");
		setDraft(true);
		setDrafting(false);
		setCreating(false);
		setPicked(null);
		let active = true;
		// Orca `pull-request-template.ts:54-61`: the template fills an empty body; one the person started stays.
		github({ op: "pr_template" }).then(
			result => {
				if (active && result.body) setBody(current => current || (result.body ?? ""));
			},
			() => {},
		);
		tabRpc.command({ type: "git_branches" }).then(
			response => {
				if (active && response.success) setBranches(response.data as RpcGitBranch[]);
			},
			() => {},
		);
		return () => {
			active = false;
		};
	}, [open, tabRpc]);

	const head = git?.branch ?? undefined;
	const defaultBase = repo?.available ? (repo.defaultBranch ?? undefined) : undefined;
	const base = picked ?? defaultBase;
	const choices = useMemo(() => baseChoices(branches, head, defaultBase), [branches, head, defaultBase]);

	const aiDraft = async () => {
		if (!sidecarReady || drafting) return;
		setDrafting(true);
		try {
			const response = await tabRpc.prDraft({ base, head });
			if (!response.success) {
				toastError({ title: t("prCenter.draftFailed"), error: response });
				return;
			}
			// pr_draft success arm carries RpcPrDraftResult — one named assertion home.
			const result = response.data as RpcPrDraftResult | undefined;
			if (result) {
				setTitle(result.title);
				setBody(result.body);
			}
		} catch (error) {
			toastError({ title: t("prCenter.draftFailed"), error });
		} finally {
			setDrafting(false);
		}
	};

	const submit = async () => {
		if (!sidecarReady || !title.trim() || creating) return;
		setCreating(true);
		try {
			const response = await tabRpc.prCreate({ title: title.trim(), body, base, head, draft });
			if (!response.success) {
				toastError({ title: t("prCenter.createFailed"), error: response });
				return;
			}
			const result = response.data as RpcPrCreateResult | undefined;
			if (result) {
				toast({ variant: "success", message: t("prCenter.created", { number: String(result.number) }) });
				openExternal(result.url);
			}
			void usePrCenterStore.getState().refresh();
			onClose();
		} catch (error) {
			toastError({ title: t("prCenter.createFailed"), error });
		} finally {
			setCreating(false);
		}
	};

	return (
		<Modal
			footer={
				<>
					<Button onClick={onClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={!sidecarReady || title.trim().length === 0}
						form={formId}
						loading={creating}
						disabledReason={!sidecarReady ? t("common.notConnected") : undefined}
						type="submit"
						variant="primary"
					>
						{t("prCenter.createSubmit")}
					</Button>
				</>
			}
			onClose={onClose}
			open={open}
			size="md"
			title={t("prCenter.createTitle")}
		>
			<form
				className="flex flex-col gap-4"
				id={formId}
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<p className="font-mono text-sc-sm text-(--sc-text-muted)">
					{t("prCenter.branches", { head: head ?? "?", base: base ?? "?" })}
				</p>
				{choices.length > 1 && (
					<Select
						label={t("prCenter.baseLabel")}
						onChange={event => setPicked(event.target.value)}
						options={choices.map(name => ({ value: name, label: name }))}
						value={base ?? ""}
					/>
				)}
				<div className="flex items-end gap-2">
					<div className="flex-1">
						<Input
							autoFocus
							label={t("prCenter.titleLabel")}
							maxLength={120}
							onChange={event => setTitle(event.target.value)}
							placeholder={t("prCenter.titlePlaceholder")}
							value={title}
						/>
					</div>
					<Button
						disabled={!sidecarReady}
						icon={<Sparkles />}
						loading={drafting}
						onClick={() => void aiDraft()}
						disabledReason={!sidecarReady ? t("common.notConnected") : undefined}
						type="button"
						variant="secondary"
					>
						{t("prCenter.aiDraft")}
					</Button>
				</div>
				<MarkdownComposer
					label={t("prCenter.bodyLabel")}
					mentions={mentions}
					onChange={setBody}
					onImage={file => uploadGithubImage(file, {})}
					placeholder={t("prCenter.bodyPlaceholder")}
					rows={10}
					value={body}
				/>
				<label className="flex w-fit cursor-pointer items-center gap-2 text-sc-md text-(--sc-text)">
					<Checkbox checked={draft} onChange={event => setDraft(event.target.checked)} />
					{t("prCenter.asDraft")}
				</label>
			</form>
		</Modal>
	);
}
