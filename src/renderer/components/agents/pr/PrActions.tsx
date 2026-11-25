/**
 * Pull request actions in the PR Center detail: merge with a method (merge commit, squash, rebase) behind a
 * confirmation, or auto-merge with it once nothing blocks (`PrAutoMergeButton`), and edit title, body (Write and
 * Preview, @mentions, pasted images) and base. Everything runs through `gh` on the active tab's repository. A fix
 * the PR needs (its comments, its failed checks) can go to an agent session on its checkout (`handToPrCheckout`).
 */
import { GitMerge, Pencil } from "lucide-react";
import { useId, useState } from "react";
import type { RpcCommand, RpcPrDetail, RpcPrMergeMethod } from "../../../../shared/rpc-types";
import { handToTab } from "../../../lib/composer-handoff";
import { uploadGithubImage } from "../../../lib/github-image";
import { useT } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { Button, Checkbox, Input, MarkdownComposer, Modal, Select } from "../../common";
import { useAssignable } from "./PrPeople";
import { PrAutoMergeButton } from "./PrStateActions";

const MERGE_METHODS: RpcPrMergeMethod[] = ["merge", "squash", "rebase"];

/** Run one gh-backed PR command; toasts a failure and answers whether it worked. */
async function runPr(command: RpcCommand, failure: string): Promise<boolean> {
	try {
		const response = await window.omp.rpc.command(command);
		if (response.success) return true;
		toastError({ title: failure, error: response });
	} catch (error) {
		toastError({ title: failure, error });
	}
	return false;
}

/** Open the PR's checkout session and put the prompt in its composer, unsent; nothing when the checkout failed (toasted). */
export async function handToPrCheckout(number: number, prompt: (cwd: string) => string): Promise<void> {
	const tabId = await usePrCenterStore.getState().checkout(number);
	if (!tabId) return;
	const cwd = useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.cwd ?? "";
	handToTab(tabId, { text: prompt(cwd), mode: "prepend" });
}

/** Why GitHub would refuse a merge right now, from `mergeStateStatus`; null when nothing blocks it. */
function mergeBlock(detail: RpcPrDetail): "draft" | "conflicts" | "blocked" | null {
	if (detail.isDraft) return "draft";
	if (detail.mergeStateStatus === "DIRTY") return "conflicts";
	if (detail.mergeStateStatus === "BLOCKED") return "blocked";
	return null;
}

export function PrMergeButton({ detail }: { detail: RpcPrDetail }) {
	const t = useT();
	const deleteId = useId();
	const [open, setOpen] = useState(false);
	const [method, setMethod] = useState<RpcPrMergeMethod>("merge");
	const [deleteBranch, setDeleteBranch] = useState(true);
	const [busy, setBusy] = useState(false);
	if (detail.state && detail.state !== "OPEN") return null;
	const block = mergeBlock(detail);
	const merge = async () => {
		setBusy(true);
		const merged = await runPr(
			{ type: "pr_merge", number: detail.number, method, deleteBranch },
			t("prCenter.merge.failed"),
		);
		setBusy(false);
		if (!merged) return;
		setOpen(false);
		toast({ variant: "success", message: t("prCenter.merge.done", { number: String(detail.number) }) });
		await usePrCenterStore.getState().reloadSelected();
	};
	return (
		<>
			<Button
				disabled={block === "draft"}
				icon={<GitMerge />}
				onClick={() => setOpen(true)}
				size="sm"
				title={block ? t(`prCenter.merge.block.${block}`) : undefined}
				variant="secondary"
			>
				{t("prCenter.merge.open")}
			</Button>
			<Modal
				footer={
					<>
						<Button autoFocus onClick={() => setOpen(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button loading={busy} onClick={() => void merge()} variant="primary">
							{t(`prCenter.merge.submit.${method}`)}
						</Button>
					</>
				}
				onClose={() => setOpen(false)}
				open={open}
				size="sm"
				title={t("prCenter.merge.title", { number: String(detail.number) })}
			>
				<div className="flex flex-col gap-3">
					<p className="text-sc-sm text-(--sc-text-secondary)">
						{t("prCenter.merge.body", { head: detail.headRefName, base: detail.baseRefName })}
					</p>
					<Select
						label={t("prCenter.merge.method")}
						onChange={event => setMethod(event.target.value as RpcPrMergeMethod)}
						options={MERGE_METHODS.map(value => ({ value, label: t(`prCenter.merge.method.${value}`) }))}
						value={method}
					/>
					<label className="flex items-center gap-2 text-sc-sm text-(--sc-text-secondary)" htmlFor={deleteId}>
						<Checkbox
							checked={deleteBranch}
							id={deleteId}
							onChange={event => setDeleteBranch(event.target.checked)}
						/>
						{t("prCenter.merge.deleteBranch", { head: detail.headRefName })}
					</label>
					{block && block !== "draft" && (
						<p className="text-sc-sm text-(--sc-warning)">{t(`prCenter.merge.block.${block}`)}</p>
					)}
					<div className="flex flex-wrap items-center gap-2">
						<PrAutoMergeButton detail={detail} method={method} />
					</div>
				</div>
			</Modal>
		</>
	);
}

export function PrEditButton({ detail }: { detail: RpcPrDetail }) {
	const mentions = useAssignable();
	const t = useT();
	const formId = useId();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState(detail.title);
	const [body, setBody] = useState(detail.body);
	const [base, setBase] = useState(detail.baseRefName);
	const [busy, setBusy] = useState(false);
	if (detail.state && detail.state !== "OPEN") return null;
	const start = () => {
		setTitle(detail.title);
		setBody(detail.body);
		setBase(detail.baseRefName);
		setOpen(true);
	};
	const save = async () => {
		if (!title.trim()) return;
		setBusy(true);
		const command: RpcCommand = {
			type: "pr_edit",
			number: detail.number,
			title: title !== detail.title ? title : undefined,
			body: body !== detail.body ? body : undefined,
			base: base.trim() && base.trim() !== detail.baseRefName ? base.trim() : undefined,
		};
		const saved = await runPr(command, t("prCenter.edit.failed"));
		setBusy(false);
		if (!saved) return;
		setOpen(false);
		await usePrCenterStore.getState().reloadSelected();
	};
	return (
		<>
			<Button icon={<Pencil />} onClick={start} size="sm" variant="secondary">
				{t("prCenter.edit.open")}
			</Button>
			<Modal
				footer={
					<>
						<Button onClick={() => setOpen(false)} variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button disabled={!title.trim()} form={formId} loading={busy} type="submit" variant="primary">
							{t("common.save")}
						</Button>
					</>
				}
				onClose={() => setOpen(false)}
				open={open}
				size="lg"
				title={t("prCenter.edit.title", { number: String(detail.number) })}
			>
				<form
					className="flex flex-col gap-3"
					id={formId}
					onSubmit={event => {
						event.preventDefault();
						void save();
					}}
				>
					<Input
						label={t("prCenter.titleLabel")}
						onChange={event => setTitle(event.target.value)}
						onInput={event => setTitle(event.currentTarget.value)}
						value={title}
					/>
					<Input
						label={t("prCenter.edit.base")}
						mono
						onChange={event => setBase(event.target.value)}
						onInput={event => setBase(event.currentTarget.value)}
						value={base}
					/>
					<MarkdownComposer
						label={t("prCenter.bodyLabel")}
						mentions={mentions}
						onChange={setBody}
						onImage={file => uploadGithubImage(file)}
						rows={10}
						value={body}
					/>
				</form>
			</Modal>
		</>
	);
}
