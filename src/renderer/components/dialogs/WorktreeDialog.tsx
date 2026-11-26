/**
 * The new task sheet (Orca FB76/FB79/FB81: `new-workspace/composer/*`, `project-selection/*`, `run-target/*`,
 * `branch-selection/*`, MIT, re-implemented): one sheet for the project, the computer it runs on, a worktree of its
 * own or not (its name, base and sparse preset), the first prompt and its files. Submit closes the sheet at once; the
 * task's steps run in `stores/new-tasks.ts` and show on its sidebar row, which keeps a failed one with Retry.
 *
 * A worktree's branch is `<prefix><name>` (Settings › Project folders › Worktree branch prefix, else omp/gui/) at
 * `~/.omp/wt/gui-<name>-<hash7>`; with no name typed, the first prompt names it (the session title model, FB40), and
 * the ✨ button asks for that name while the sheet is open. Its git runs on a tab of the chosen computer: the focused
 * tab when it runs there, else any tab there. A repository with no `.ompdesk/worktree-setup` is offered a draft from
 * another tool's config (FX21), which the person reads, edits and saves; nothing runs unseen.
 */

import { Paperclip } from "lucide-react";
import { type CSSProperties, type DragEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RpcGitBranch, RpcSetupDraft, RpcSparsePreset, RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import {
	GUI_WORKTREE_BRANCH_PREFIX,
	WORKTREE_BRANCH_PREFIX_PREF,
	worktreeBranchPrefix,
} from "../../../shared/worktree-branch";
import { useSessionList } from "../../hooks/use-session-list";
import { inlineFailure } from "../../lib/error-detail";
import { basename } from "../../lib/format";
import { translate, useT } from "../../lib/i18n";
import { createTabRpc, type TabRpc, useTabRpc } from "../../lib/tab-rpc";
import { pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { setNewTaskAnnouncer, startNewTask, worktreeSlug } from "../../stores/new-tasks";
import { useFocusedTabDevice, useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	AutoTitleButton,
	Button,
	Checkbox,
	Chip,
	Collapse,
	FieldLabel,
	Input,
	Modal,
	Radio,
	Select,
	TextArea,
} from "../common";

/**
 * One toast for what fetching the remote default branch brought, what `.worktreeinclude` copied and how
 * `.ompdesk/worktree-setup` went; nothing when none ran.
 */
export function announcePreparation(
	result: RpcWorktreeCreateResult,
	t: (key: string, params?: Record<string, string | number>) => string,
): void {
	const { base, seed, setup } = result;
	if (!base && !seed && !setup) return;
	const lines: string[] = [];
	if (base) {
		const ref = base.ref;
		lines.push(
			base.error
				? t("worktree.baseFetchFailed", { ref })
				: !base.fetched
					? t("worktree.baseRecent", { ref })
					: base.behind
						? t("worktree.baseFetched", { ref, count: base.behind })
						: t("worktree.baseUpToDate", { ref }),
		);
	}
	if (seed) {
		lines.push(
			seed.skipped.length
				? t("worktree.seedCopiedSkipped", { count: seed.copied, skipped: seed.skipped.length })
				: t("worktree.seedCopied", { count: seed.copied }),
		);
	}
	if (setup)
		lines.push(
			setup.ok ? t("worktree.setupOk") : t(setup.timedOut ? "worktree.setupTimedOut" : "worktree.setupFailed"),
		);
	const detail = [
		...(base?.error ? [base.error] : (base?.subjects ?? [])),
		...(seed?.skipped.map(item => `${item.path}: ${item.reason}`) ?? []),
		...(setup && !setup.ok ? [setup.logPath, setup.outputTail] : []),
	].join("\n");
	toast({
		variant: base?.error || (setup && !setup.ok) ? "warning" : "info",
		message: lines.join(" · "),
		...(detail ? { detail } : {}),
	});
}

setNewTaskAnnouncer(made => announcePreparation(made, translate));

type BaseChoice = "HEAD" | "default" | "ref";
const LOCAL = "";

/** A tab of the computer `device` runs, whose main answers the worktree commands; the focused tab first. */
function useDeviceRpc(device: string | undefined): TabRpc | null {
	const focusedRpc = useTabRpc();
	const focusedDevice = useFocusedTabDevice();
	const otherTab = useTabsStore(state => state.tabs.find(tab => tab.device === device && !tab.placeholder)?.id);
	return useMemo(() => {
		if (focusedDevice === device) return focusedRpc;
		return otherTab ? createTabRpc(ensureTabRuntime(otherTab).command) : null;
	}, [device, focusedDevice, focusedRpc, otherTab]);
}

/** The project folders this computer's (or the paired host's) sessions worked in, newest first. */
function useProjects(device: string | undefined, pinned: readonly string[]): string[] {
	const { sessions } = useSessionList("global", device);
	return useMemo(() => {
		const seen = new Map<string, number>();
		for (const session of sessions) {
			if (session.kind === "chat" || /[\\/]gui-[^\\/]+-[0-9a-f]{7}$/.test(session.cwd)) continue;
			const at = Date.parse(session.modified) || 0;
			if ((seen.get(session.cwd) ?? -1) < at) seen.set(session.cwd, at);
		}
		const recent = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
		return [...new Set([...pinned.filter(Boolean), ...recent])].slice(0, 15);
	}, [sessions, pinned]);
}

export function WorktreeDialog() {
	const t = useT();
	const formId = useId();
	const dialog = useUiStore(state => state.worktreeDialog);
	const close = useUiStore(state => state.closeWorktreeDialog);
	const sessionCwd = useSessionStore(state => state.cwd);
	const focusedDevice = useFocusedTabDevice();
	const hosts = useRemoteStore(state => state.state?.hosts);

	const [device, setDevice] = useState<string | undefined>(undefined);
	const [project, setProject] = useState("");
	const [prompt, setPrompt] = useState("");
	const [files, setFiles] = useState<File[]>([]);
	const [worktree, setWorktree] = useState(true);
	const [name, setName] = useState("");
	const [base, setBase] = useState<BaseChoice>("HEAD");
	const [ref, setRef] = useState("");
	const [sparse, setSparse] = useState("");
	const [presets, setPresets] = useState<RpcSparsePreset[]>([]);
	const [draft, setDraft] = useState<RpcSetupDraft | null>(null);
	const [draftText, setDraftText] = useState("");
	const [draftOpen, setDraftOpen] = useState(false);
	const [savingDraft, setSavingDraft] = useState(false);
	const [suggesting, setSuggesting] = useState(false);
	const [branches, setBranches] = useState<RpcGitBranch[]>([]);
	const [branchPrefix, setBranchPrefix] = useState<string | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const branchListId = useId();

	const rpc = useDeviceRpc(device);
	const projects = useProjects(device, device === focusedDevice ? [dialog?.baseCwd ?? "", sessionCwd] : []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: an opening, not every focus change, sets the start values.
	useEffect(() => {
		if (!dialog) return;
		setDevice(focusedDevice);
		setProject(dialog.baseCwd ?? sessionCwd);
		setPrompt(dialog.prompt ?? "");
		setFiles([]);
		setWorktree(true);
		setName(dialog.name ? worktreeSlug(dialog.name) : "");
		setBase("HEAD");
		setRef("");
		setSparse("");
		setDraftOpen(false);
		let live = true;
		// Started inside a promise so a missing prefs API (tests) leaves the default prefix.
		void Promise.resolve()
			.then(() => window.omp.prefs.get(WORKTREE_BRANCH_PREFIX_PREF))
			.then(
				stored => {
					if (live) setBranchPrefix(worktreeBranchPrefix(stored));
				},
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, [dialog]);

	// What the project's repository offers a worktree: the remote default branch fetched while the person types (so a
	// `default`-based create finds it fresh), its sparse presets, its branches and a setup draft when it has no script.
	const repoCwd = dialog && worktree && rpc ? project : "";
	useEffect(() => {
		setPresets([]);
		setDraft(null);
		setBranches([]);
		if (!repoCwd || !rpc) return;
		let live = true;
		rpc.worktreePrefetch(repoCwd).catch(() => undefined);
		void rpc.worktreeSparsePresets(repoCwd).then(
			response => {
				if (live && response.success) setPresets((response.data as RpcSparsePreset[] | null) ?? []);
			},
			() => undefined,
		);
		void rpc.worktreeSetupDraft(repoCwd).then(
			response => {
				const found = response.success ? (response.data as RpcSetupDraft | null) : null;
				if (!live) return;
				setDraft(found);
				setDraftText(found?.text ?? "");
			},
			() => undefined,
		);
		void rpc.command({ type: "git_branches" }).then(
			response => {
				if (live && response.success) setBranches((response.data as RpcGitBranch[] | null) ?? []);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [repoCwd, rpc]);

	const slug = worktreeSlug(name);
	const nameValid = !name.trim() || (/^[a-z0-9 -]+$/i.test(name) && /^[a-z0-9][a-z0-9-]{0,40}$/.test(slug));
	const baseRef = base === "ref" ? ref.trim() : base;
	const canStart = Boolean(project) && (!worktree || (rpc !== null && nameValid && baseRef !== ""));
	const deviceName = (id: string | undefined) =>
		id === undefined ? t("newTask.thisComputer") : (hosts?.find(host => host.deviceId === id)?.name ?? id);

	const submit = () => {
		if (!canStart || !rpc) return;
		startNewTask(
			{
				baseCwd: project,
				...(device === undefined ? {} : { device }),
				worktree,
				name: name.trim(),
				baseRef,
				...(branchPrefix ? { branchPrefix } : {}),
				...(sparse ? { sparse } : {}),
				prompt: prompt.trim(),
				files,
			},
			rpc,
		);
		close();
	};

	const suggest = async () => {
		if (!rpc || !prompt.trim()) return;
		setSuggesting(true);
		try {
			const response = await rpc.worktreeNameSuggest(prompt.trim());
			const title = response.success ? (response.data as { title?: string | null } | null)?.title : null;
			const suggested = title ? worktreeSlug(title) : "";
			if (suggested) setName(suggested);
			else toast({ variant: "info", message: t("newTask.noSuggestion") });
		} catch (error) {
			toastError({ title: t("newTask.noSuggestion"), error });
		} finally {
			setSuggesting(false);
		}
	};

	const saveDraft = async () => {
		if (!rpc || !draft) return;
		setSavingDraft(true);
		try {
			const response = await rpc.worktreeSetupSave(project, draftText);
			if (!response.success) throw response;
			toast({ variant: "success", message: t("newTask.setupSaved", { script: draft.script }) });
			setDraft(null);
		} catch (error) {
			toastError({ title: t("newTask.setupSaveFailed"), error: inlineFailure(error, t("newTask.setupSaveFailed")) });
		} finally {
			setSavingDraft(false);
		}
	};

	const addFiles = (list: FileList | null) => {
		if (list && list.length > 0) setFiles(previous => [...previous, ...Array.from(list)]);
	};
	const onDrop = (event: DragEvent) => {
		if (event.dataTransfer.files.length === 0) return;
		event.preventDefault();
		addFiles(event.dataTransfer.files);
	};

	const deviceOptions = [
		{ value: LOCAL, label: t("newTask.thisComputer") },
		...(hosts ?? [])
			.filter(host => host.state === "online" || host.deviceId === device)
			.map(host => ({ value: host.deviceId, label: host.name })),
	];

	return (
		<Modal
			open={dialog !== null}
			onClose={close}
			title={t("worktree.title")}
			size="md"
			footer={
				<>
					<Button type="button" variant="ghost" onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button
						type="submit"
						form={formId}
						variant="primary"
						disabled={!canStart}
						disabledReason={
							worktree && !rpc ? t("newTask.noTabThere", { device: deviceName(device) }) : undefined
						}
					>
						{t("worktree.submit")}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				className="flex flex-col gap-3"
				data-new-task-sheet
				onSubmit={event => {
					event.preventDefault();
					submit();
				}}
			>
				{deviceOptions.length > 1 && (
					<Select
						data-new-task-device
						label={t("newTask.device")}
						onChange={event => {
							const next = event.target.value || undefined;
							setDevice(next);
							setProject(next === focusedDevice ? (dialog?.baseCwd ?? sessionCwd) : "");
						}}
						options={deviceOptions}
						value={device ?? LOCAL}
					/>
				)}
				<div className="flex items-end gap-2">
					<div className="min-w-0 flex-1">
						<Select
							data-new-task-project
							label={t("newTask.project")}
							onChange={event => setProject(event.target.value)}
							options={[...(project && !projects.includes(project) ? [project] : []), ...projects].map(cwd => ({
								value: cwd,
								label: `${basename(cwd)} — ${cwd}`,
							}))}
							value={project}
						/>
					</div>
					<Button
						onClick={() => {
							void pickWorkspaceDirectory({ device })
								.then(folder => {
									if (folder) setProject(folder);
								})
								.catch(() => undefined);
						}}
						type="button"
						variant="secondary"
					>
						{t("newTask.chooseFolder")}
					</Button>
				</div>
				<TextArea
					autoGrow
					data-new-task-prompt
					label={t("newTask.prompt")}
					onChange={event => setPrompt(event.target.value)}
					onDragOver={event => {
						if (event.dataTransfer.types.includes("Files")) event.preventDefault();
					}}
					onDrop={onDrop}
					placeholder={t("newTask.promptPlaceholder")}
					rows={3}
					value={prompt}
				/>
				{/* On touch each button's reach stops half way to the worktree switch's row (the form's 12 px gap). */}
				<div
					className="flex flex-wrap items-center gap-1.5"
					style={{ "--hit-gap-x": "6px", "--hit-gap-y": "12px" } as CSSProperties}
				>
					<Button
						icon={<Paperclip />}
						onClick={() => fileInput.current?.click()}
						size="sm"
						type="button"
						variant="ghost"
					>
						{t("newTask.attach")}
					</Button>
					<input
						className="hidden"
						multiple
						onChange={event => {
							addFiles(event.target.files);
							event.target.value = "";
						}}
						ref={fileInput}
						type="file"
					/>
					{files.map((file, at) => (
						<Chip
							key={`${file.name}:${at}`}
							onRemove={() => setFiles(previous => previous.filter((_, index) => index !== at))}
							removeLabel={t("newTask.removeFile", { name: file.name })}
						>
							{file.name}
						</Chip>
					))}
				</div>
				<label className="flex min-h-8 cursor-pointer items-center gap-2 text-sc-md text-(--sc-text)">
					<Checkbox
						checked={worktree}
						data-new-task-worktree
						onChange={event => setWorktree(event.target.checked)}
					/>
					{t("newTask.ownWorktree")}
				</label>
				<Collapse open={worktree}>
					<div className="flex flex-col gap-3 pl-6">
						{/* The suggest button's reach stops half way to the field (the row's 8 px gap), or a tablet tap on the
						    field's right edge was the button's. Beside the field, not inside it: on a phone the button is 44 px
						    high over a 36 px field. */}
						<div className="flex items-end gap-2" style={{ "--hit-gap-x": "8px" } as CSSProperties}>
							<div className="min-w-0 flex-1">
								<Input
									label={t("worktree.nameLabel")}
									maxLength={41}
									onChange={event => setName(event.target.value)}
									placeholder={t("newTask.namePlaceholder")}
									value={name}
								/>
							</div>
							<AutoTitleButton
								onClick={() => void suggest()}
								pending={suggesting}
								unavailableReason={prompt.trim() ? undefined : t("newTask.suggestNeedsPrompt")}
							/>
						</div>
						{name.trim() && nameValid && (
							<p className="text-sc-sm text-(--sc-text-muted)">
								{t("worktree.branchPreview", {
									branch: `${branchPrefix ?? GUI_WORKTREE_BRANCH_PREFIX}${slug}`,
								})}
							</p>
						)}
						{!nameValid && (
							<p role="alert" className="text-sc-sm text-(--sc-danger)">
								{t("worktree.invalidName")}
							</p>
						)}
						<fieldset data-worktree-base className="flex flex-col gap-1.5">
							<FieldLabel as="legend">{t("worktree.baseLabel")}</FieldLabel>
							{(["HEAD", "default", "ref"] as const).map(value => (
								<label
									key={value}
									className="flex min-h-8 cursor-pointer items-center gap-2 text-sc-md text-(--sc-text)"
								>
									<Radio name="worktree-base" checked={base === value} onChange={() => setBase(value)} />
									{t(
										value === "HEAD"
											? "worktree.baseHead"
											: value === "default"
												? "worktree.baseDefault"
												: "newTask.baseRef",
									)}
								</label>
							))}
							{base === "ref" && (
								<>
									<Input
										aria-label={t("newTask.baseRef")}
										list={branchListId}
										onChange={event => setRef(event.target.value)}
										placeholder="origin/main"
										value={ref}
									/>
									<datalist id={branchListId}>
										{branches.map(branch => (
											<option key={branch.name} value={branch.name} />
										))}
									</datalist>
								</>
							)}
							<p className="text-sc-sm text-(--sc-text-secondary)">{t("worktree.baseScope")}</p>
						</fieldset>
						{presets.length > 0 && (
							<Select
								data-new-task-sparse
								hint={t("newTask.sparseHint")}
								label={t("newTask.sparse")}
								onChange={event => setSparse(event.target.value)}
								options={[
									{ value: "", label: t("newTask.sparseWhole") },
									...presets.map(preset => ({
										value: preset.name,
										label: `${preset.name} (${preset.folders.join(", ")})`,
									})),
								]}
								value={sparse}
							/>
						)}
						{draft && (
							<div className="flex flex-col gap-2" data-new-task-setup-draft>
								<p className="text-sc-sm text-(--sc-text-secondary)">
									{t("newTask.setupDraft", { file: draft.file, script: draft.script })}{" "}
									<Button onClick={() => setDraftOpen(open => !open)} size="sm" type="button" variant="ghost">
										{t(draftOpen ? "newTask.setupHide" : "newTask.setupReview")}
									</Button>
								</p>
								<Collapse open={draftOpen}>
									<div className="flex flex-col gap-2">
										<TextArea
											aria-label={draft.script}
											autoGrow
											mono
											onChange={event => setDraftText(event.target.value)}
											value={draftText}
										/>
										<div>
											<Button
												loading={savingDraft}
												onClick={() => void saveDraft()}
												size="sm"
												type="button"
												variant="secondary"
											>
												{t("newTask.setupSave", { script: draft.script })}
											</Button>
										</div>
									</div>
								</Collapse>
							</div>
						)}
					</div>
				</Collapse>
			</form>
		</Modal>
	);
}
