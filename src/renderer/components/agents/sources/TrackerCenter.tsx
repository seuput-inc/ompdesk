/**
 * Agents › GitHub's Linear and Jira sources (Orca's task page, `task-page/linear/**`, `task-page/jira/**`): one
 * account's work items, or every account's merged by their last change, with Orca's presets and a search; an item's
 * description and comments, a move to another state (a Linear workflow state of its team, a Jira transition), a
 * comment, and a session started on it in a new worktree with the item as its first prompt's data.
 */
import {
	Circle,
	CircleCheck,
	CircleDashed,
	CircleDot,
	CircleX,
	ExternalLink,
	Play,
	RefreshCw,
	Trash2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	type TrackerDetail as Detail,
	TRACKER_PROVIDER_PRESETS,
	type TrackerPreset,
	type TrackerProvider,
	type TrackerStateCategory,
	type TrackersState,
	trackerStartPrompt,
	trackerWorktreeName,
} from "../../../../shared/trackers";
import { cx, formatTimeAgo } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { MarkdownRenderer } from "../../../lib/markdown";
import { openExternal } from "../../../lib/open-external";
import { startOnItem } from "../../../lib/start-item";
import { trackerErrorText, useTrackerLoad } from "../../../lib/trackers";
import { toastError } from "../../../stores/toast";
import {
	AsyncSection,
	Badge,
	Banner,
	Button,
	Card,
	ConfirmDialog,
	IconButton,
	ListRow,
	MasterDetail,
	Modal,
	SearchField,
	Select,
	Skeleton,
	Tabs,
	TextArea,
} from "../../common";
import { GithubToolbar } from "../github/shared";
import { TrackerConnectCard, TrackerConnectForm } from "./TrackerConnect";

const CATEGORY_ICON: Record<TrackerStateCategory, [typeof Circle, string]> = {
	backlog: [CircleDashed, "text-(--sc-text-subtle)"],
	unstarted: [Circle, "text-(--sc-text-muted)"],
	started: [CircleDot, "text-(--sc-warning)"],
	completed: [CircleCheck, "text-(--sc-success)"],
	canceled: [CircleX, "text-(--sc-text-subtle)"],
};

function StateIcon({ category }: { category: TrackerStateCategory }) {
	const [Icon, tone] = CATEGORY_ICON[category];
	return <Icon aria-hidden className={cx("size-(--sc-icon-sm) shrink-0", tone)} />;
}

function ItemDetail({ item, onChanged }: { item: Detail; onChanged: () => void }) {
	const t = useT();
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState<"comment" | "state" | null>(null);
	const [wantStates, setWantStates] = useState(false);
	const states = useTrackerLoad(
		wantStates ? { action: "states", accountId: item.accountId, id: item.id } : null,
		`${item.accountId}|${item.id}`,
	);
	const write = async (what: "comment" | "state", action: () => Promise<unknown>) => {
		setBusy(what);
		try {
			await action();
			if (what === "comment") setComment("");
			onChanged();
		} catch (error) {
			toastError({ title: t("trackers.writeFailed"), error: trackerErrorText(error) });
		} finally {
			setBusy(null);
		}
	};
	// Linear's priority by its number (Linear's own names), Jira's by the site's own name.
	const priority =
		item.priority?.name ?? (item.priority?.value ? t(`trackers.linear.priority.${item.priority.value}`) : null);
	return (
		<article className="flex flex-col gap-4 px-6 py-5 min-[1280px]:px-10" data-tracker-item={item.key}>
			<header className="flex flex-col gap-2">
				<h3 className="text-sc-lg font-semibold text-(--sc-text)">
					{item.title} <span className="font-normal text-(--sc-text-muted)">{item.key}</span>
				</h3>
				<div className="flex flex-wrap items-center gap-2 text-sc-xs text-(--sc-text-muted)">
					<Badge variant={item.state.category === "completed" ? "success" : "muted"}>{item.state.name}</Badge>
					{priority && <span>{priority}</span>}
					{item.assignee && <span>{item.assignee.name}</span>}
					{item.container && <span>{item.container.name}</span>}
					<span>{item.accountLabel}</span>
					<span>{formatTimeAgo(item.updatedAt)}</span>
				</div>
				{item.labels.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{item.labels.map(label => (
							<Badge key={label} size="xs" variant="muted">
								{label}
							</Badge>
						))}
					</div>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						data-tracker-start
						icon={<Play />}
						onClick={() =>
							startOnItem({
								name: trackerWorktreeName(item),
								prompt: trackerStartPrompt(item, t("trackers.startAsk", { key: item.key })),
							})
						}
						size="sm"
						variant="primary"
					>
						{t("trackers.start")}
					</Button>
					<Select
						aria-label={t("trackers.moveTo")}
						controlSize="sm"
						disabled={busy === "state"}
						onChange={event => {
							const stateId = event.target.value;
							if (!stateId) return;
							void write("state", () =>
								window.omp.trackers.command({
									action: "setState",
									accountId: item.accountId,
									id: item.id,
									stateId,
								}),
							);
						}}
						onFocus={() => setWantStates(true)}
						onPointerDown={() => setWantStates(true)}
						options={[
							{ value: "", label: states.loading ? t("common.loading") : t("trackers.moveTo") },
							...(states.data ?? []).map(option => ({ value: option.id, label: option.name })),
						]}
						value=""
					/>
					<Button icon={<ExternalLink />} onClick={() => openExternal(item.url)} size="sm" variant="ghost">
						{t(`trackers.${item.provider}.open`)}
					</Button>
				</div>
				{states.error && <p className="text-sc-sm text-(--sc-danger)">{states.error}</p>}
			</header>
			<div className="text-sc-md">
				{item.description.trim() ? (
					<MarkdownRenderer content={item.description} />
				) : (
					<p className="text-(--sc-text-muted)">{t("trackers.noDescription")}</p>
				)}
			</div>
			{item.children.length > 0 && (
				<section aria-label={t("trackers.children")} className="flex flex-col gap-1">
					<h4 className="text-sc-sm font-semibold text-(--sc-text)">{t("trackers.children")}</h4>
					{item.children.map(child => (
						<ListRow
							key={child.key}
							onClick={() => openExternal(child.url)}
							secondary={<span className="shrink-0">{child.key}</span>}
							size="sm"
							title={child.title}
						/>
					))}
				</section>
			)}
			<section
				aria-label={t("trackers.comments")}
				className="flex flex-col gap-3 border-t border-(--sc-divider) pt-4"
			>
				{item.comments.map(entry => (
					<Card key={entry.id} padding="sm">
						<div className="mb-1 text-sc-xs text-(--sc-text-muted)">
							{entry.author} · {formatTimeAgo(entry.createdAt)}
						</div>
						<MarkdownRenderer content={entry.body} />
					</Card>
				))}
				<form
					className="flex flex-col gap-2"
					onSubmit={event => {
						event.preventDefault();
						const body = comment.trim();
						if (!body) return;
						void write("comment", () =>
							window.omp.trackers.command({ action: "comment", accountId: item.accountId, id: item.id, body }),
						);
					}}
				>
					<TextArea
						label={t("trackers.addComment")}
						onChange={event => setComment(event.target.value)}
						rows={3}
						value={comment}
					/>
					<div>
						<Button
							disabled={!comment.trim()}
							loading={busy === "comment"}
							size="sm"
							type="submit"
							variant="secondary"
						>
							{t("trackers.comment")}
						</Button>
					</div>
				</form>
			</section>
		</article>
	);
}

function Browser({
	provider,
	state,
	onState,
}: {
	provider: TrackerProvider;
	state: TrackersState;
	onState: (state: TrackersState) => void;
}) {
	const t = useT();
	const formId = useId();
	const accounts = state.accounts.filter(account => account.provider === provider);
	const account = state.selected[provider] ?? accounts[0]?.id ?? "all";
	const shown = account === "all" ? accounts : accounts.filter(item => item.id === account);
	const [preset, setPreset] = useState<TrackerPreset>("assigned");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [selected, setSelected] = useState<{ accountId: string; id: string } | null>(null);
	const [connecting, setConnecting] = useState(false);
	const [connectBusy, setConnectBusy] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const list = useTrackerLoad(
		{ action: "list", provider, account, preset, ...(search ? { search } : {}) },
		`${provider}|${account}|${preset}|${search}`,
	);
	const detail = useTrackerLoad(
		selected ? { action: "detail", accountId: selected.accountId, id: selected.id } : null,
		selected ? `${selected.accountId}|${selected.id}` : "",
	);
	// A changed source or list shows no item of another.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new provider or account starts with no item chosen.
	useEffect(() => setSelected(null), [provider, account]);
	const reconnect = shown.filter(item => item.needsReconnect);
	const rows = list.data?.items ?? [];
	const select = (value: string) =>
		window.omp.trackers
			.command({ action: "select", provider, selected: value })
			.then(onState, (error: unknown) =>
				toastError({ title: t("trackers.writeFailed"), error: trackerErrorText(error) }),
			);
	return (
		<>
			<GithubToolbar>
				<Select
					aria-label={t(`trackers.${provider}.account`)}
					controlSize="sm"
					onChange={event => void select(event.target.value)}
					options={[
						...(accounts.length > 1 ? [{ value: "all", label: t(`trackers.${provider}.all`) }] : []),
						...accounts.map(item => ({ value: item.id, label: item.label })),
					]}
					value={account}
				/>
				<Tabs
					activeId={preset}
					ariaLabel={t("trackers.presets")}
					onChange={id => setPreset(id as TrackerPreset)}
					tabs={TRACKER_PROVIDER_PRESETS[provider].map(id => ({
						id,
						label: t(`trackers.preset.${provider}.${id}`),
					}))}
					variant="segmented"
				/>
				<form
					className="min-w-48 flex-1"
					onSubmit={event => {
						event.preventDefault();
						setSearch(query.trim());
					}}
				>
					<SearchField label={t(`trackers.${provider}.search`)} onValueChange={setQuery} value={query} />
				</form>
				<IconButton
					icon={<RefreshCw />}
					label={t("common.refresh")}
					loading={list.loading}
					onClick={() => {
						list.reload(true);
						if (selected) detail.reload(true);
					}}
				/>
				<Button onClick={() => setConnecting(true)} size="sm" variant="secondary">
					{t(`trackers.${provider}.add`)}
				</Button>
				{account !== "all" && (
					<IconButton
						icon={<Trash2 />}
						label={t("trackers.remove", { name: shown[0]?.label ?? "" })}
						onClick={() => setRemoving(account)}
					/>
				)}
			</GithubToolbar>
			{reconnect.length > 0 && (
				<Banner
					actions={
						<Button onClick={() => setConnecting(true)} size="sm" variant="secondary">
							{t("trackers.reconnect")}
						</Button>
					}
					className="mx-6 mt-2"
					variant="warning"
				>
					{t("trackers.needsReconnect", { names: reconnect.map(item => item.label).join(", ") })}
				</Banner>
			)}
			{(list.data?.errors ?? [])
				.filter(error => error.type !== "auth")
				.map(error => (
					<Banner className="mx-6 mt-2" compact key={error.accountId} variant="neutral">
						{t("trackers.accountFailed", { name: error.accountLabel, reason: error.message })}
					</Banner>
				))}
			<MasterDetail
				detail={
					selected === null ? null : (
						<AsyncSection
							error={detail.error}
							hasData={detail.data !== null}
							loading={detail.loading && !detail.data}
							onRetry={() => detail.reload(true)}
						>
							{detail.data && (
								<ItemDetail
									item={detail.data}
									onChanged={() => {
										detail.reload(true);
										list.reload(true);
									}}
								/>
							)}
						</AsyncSection>
					)
				}
				label={t(`trackers.${provider}.list`)}
				list={
					<AsyncSection
						emptyLabel={t("trackers.empty")}
						empty={rows.length === 0}
						error={list.error}
						hasData={rows.length > 0}
						loading={list.loading && !list.data}
						onRetry={() => list.reload(true)}
					>
						<ul className="flex flex-col gap-0.5" data-tracker-list={provider}>
							{rows.map(item => (
								<li key={`${item.accountId}|${item.id}`}>
									<ListRow
										leading={<StateIcon category={item.state.category} />}
										onClick={() => setSelected({ accountId: item.accountId, id: item.id })}
										secondary={
											<>
												<span className="shrink-0 tabular-nums">{item.key}</span>
												<span className="min-w-0 flex-1 truncate">
													{[
														item.state.name,
														item.assignee?.name,
														account === "all" ? item.accountLabel : null,
													]
														.filter(Boolean)
														.join(" · ")}
												</span>
												<span className="shrink-0">{formatTimeAgo(item.updatedAt)}</span>
											</>
										}
										selected={selected?.accountId === item.accountId && selected.id === item.id}
										size="sm"
										title={item.title}
									/>
								</li>
							))}
							{list.data?.hasMore && (
								<li className="px-3 py-2 text-sc-xs text-(--sc-text-muted)">{t("trackers.more")}</li>
							)}
						</ul>
					</AsyncSection>
				}
				onBack={() => setSelected(null)}
				open={selected !== null}
			/>
			<Modal
				footer={
					<>
						<Button onClick={() => setConnecting(false)} variant="ghost">
							{t("common.cancel")}
						</Button>
						<Button form={formId} loading={connectBusy} type="submit" variant="primary">
							{t("trackers.connect")}
						</Button>
					</>
				}
				onClose={() => setConnecting(false)}
				open={connecting}
				size="sm"
				title={t(`trackers.${provider}.connectTitle`)}
			>
				<TrackerConnectForm
					formId={formId}
					onBusy={setConnectBusy}
					onConnected={next => {
						setConnecting(false);
						onState(next);
					}}
					provider={provider}
				/>
			</Modal>
			<ConfirmDialog
				confirmLabel={t("trackers.removeConfirm")}
				message={t("trackers.removeMessage")}
				onCancel={() => setRemoving(null)}
				onConfirm={() => {
					const id = removing;
					setRemoving(null);
					if (!id) return;
					window.omp.trackers
						.accounts({ action: "remove", id })
						.then(onState, (error: unknown) =>
							toastError({ title: t("trackers.writeFailed"), error: trackerErrorText(error) }),
						);
				}}
				open={removing !== null}
				title={t("trackers.remove", { name: accounts.find(item => item.id === removing)?.label ?? "" })}
			/>
		</>
	);
}

export function TrackerCenter({ provider }: { provider: TrackerProvider }) {
	const t = useT();
	const [state, setState] = useState<TrackersState | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		window.omp.trackers.command({ action: "state" }).then(
			next => {
				if (live) setState(next);
			},
			(failure: unknown) => {
				if (live) setError(trackerErrorText(failure));
			},
		);
		return () => {
			live = false;
		};
	}, []);
	if (!state)
		return error ? (
			<p className="px-6 py-4 text-sc-sm text-(--sc-danger)" role="alert">
				{error}
			</p>
		) : (
			<div aria-busy className="px-6 py-4">
				<Skeleton className="h-7 w-72 rounded-(--sc-radius-md)" />
			</div>
		);
	if (!state.accounts.some(account => account.provider === provider))
		return (
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<TrackerConnectCard onConnected={setState} provider={provider} />
				<p className="px-6 text-center text-sc-xs text-(--sc-text-muted)">{t("trackers.thisComputer")}</p>
			</div>
		);
	return <Browser onState={setState} provider={provider} state={state} />;
}
