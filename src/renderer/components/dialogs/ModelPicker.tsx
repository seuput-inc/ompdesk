/**
 * Model picker (Picker container): search, models grouped by provider as in
 * every model list (`groupModelsByProvider`), current model checked. Picking switches this
 * session only (stock `set_model`, which persists nothing). The default new sessions open on
 * (`modelRoles.default`) is written only by Settings › Models & accounts › Model roles (the
 * owner's rule); a first run with no default is settled by `ensureServingDefault`.
 */

import { Check, KeyRound, RefreshCw, Settings2, TriangleAlert } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ModelInfo, ModelReleaseDatesResult } from "../../../shared/rpc-types";
import { applyModelInfo, hydrateSession } from "../../hooks/use-rpc-events";
import { compactionPointValue, useCompactionPoints } from "../../lib/compaction-limits";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { cx, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import { runManualMaintenance } from "../../lib/messages";
import { claudeApiKeyLabel, modelProviderGroup } from "../../lib/model-provider-group";
import { useTabRpc } from "../../lib/tab-rpc";
import { chosenModelOf, useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Button,
	Collapse,
	DisclosureButton,
	EmptyState,
	IconButton,
	InlineNotice,
	KeyHints,
	Modal,
	type ModalAnchor,
	OptionGroup,
	OptionRow,
	SearchField,
	SettingInfo,
	SkeletonRows,
	Spinner,
	Tabs,
} from "../common";
import { KeyQueryFailure } from "../common/KeyQueryFailure";
import { ThinkingLevelField } from "../layout/composer/ThinkingControl";
import { ProviderMark } from "../settings/providers/ProviderMark";
import { MIN_SERVING_CONTEXT, modelDisplayName } from "../settings/providers/provider-catalog";
import { compactModelLabels, groupModelsByProvider } from "../settings/providers/provider-marks";

/** Rows in the Recent group (stock's `/models` hub keeps 15; a dialog wants a glance). */
const RECENT_LIMIT = 5;
const RECENT_GROUP = "recent";
const CURRENT_GROUP = "current";
const AUTO_GROUP = "claude-api-auto";

interface PickerGroup {
	id: string;
	/** The provider every row belongs to; null for the Current and Recent groups. */
	provider: string | null;
	models: ModelInfo[];
	collapsed: boolean;
}

export function ModelPicker() {
	const tabRpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen);
	const close = useUiStore(state => state.closeModelPicker);
	const openProviders = useUiStore(state => state.openProviders);
	const generation = useModelStore(state => state.catalogGeneration);
	const [readSince, setReadSince] = useState<number | null>(() => generation);
	const accountRead = readSince === null || generation > readSince;
	const catalog = useModelStore(state => state.availableModels);
	const discovery = useModelStore(state => state.discoveryStates);
	const failedKeys = useMemo(
		() =>
			new Map(
				discovery
					.filter(s => s.status === "unavailable" && modelProviderGroup(s.provider) === "anthropic-api-key")
					.map(s => [s.provider, s]),
			),
		[discovery],
	);
	const availableModels = useMemo(
		() =>
			catalog.filter(
				row =>
					!failedKeys.has(row.provider) &&
					(!row.pickerAvailability || (accountRead && row.pickerAvailability !== "account-unverified")),
			),
		[catalog, accountRead, failedKeys],
	);
	const unconfirmed = catalog.some(
		row =>
			!failedKeys.has(row.provider) &&
			row.pickerAvailability &&
			(!accountRead || row.pickerAvailability === "account-unverified"),
	);
	const catalogProviders = useModelStore(state => state.providers);
	// The person's model is checked, also while a fallback answers in its place.
	const current = useModelStore(chosenModelOf);
	const autoRoute = useModelStore(state => state.claudeApiRoute);
	const supportsThinking = useModelStore(state => state.availableThinkingLevels.length > 0);
	const refreshProviders = useModelStore(state => state.refreshProviders);
	// Live session usage: models whose window is smaller render with an
	// over-context warning and compact-first on pick (TUI markOverContext parity).
	const contextUsage = useSessionStore(state => state.contextUsage);
	const sidecarReady = useSessionStore(state => state.status) === "ready";
	// Where each model auto-compacts (stock `/models` preview parity); null on an omp before 18.8.5.
	const compactionPoints = useCompactionPoints(open);

	const [query, setQuery] = useState("");
	const [pickedGroup, setPickedGroup] = useState<string | null>(null);
	const [openRouterExpanded, setOpenRouterExpanded] = useState(false);
	const [releaseDates, setReleaseDates] = useState<ReadonlyMap<string, number>>(() => new Map());
	const [switching, setSwitching] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	const requestVersion = useRef(0);
	const [recentSelectors, setRecentSelectors] = useState<readonly string[]>([]);

	const load = useCallback(
		async (forceRefresh: boolean, failedCopy?: string): Promise<void> => {
			const version = ++requestVersion.current;
			// The list the store already holds (this session's, or the last run's snapshot) stays on screen and the
			// read replaces it in place: the wait only shows when nothing is known yet.
			const known = useModelStore.getState().availableModels.length > 0;
			setLoading(!known);
			setError(null);
			if (!sidecarReady) {
				if (!known) setError({ message: t("modelPicker.notConnected") });
				setLoading(false);
				return;
			}
			try {
				await refreshProviders(forceRefresh);
				if (version === requestVersion.current) setReadSince(null);
			} catch (cause) {
				if (version === requestVersion.current)
					setError(
						failedCopy ? { message: failedCopy, cause } : inlineFailure(cause, t("modelPicker.notResponding")),
					);
			} finally {
				if (version === requestVersion.current) setLoading(false);
			}
		},
		[refreshProviders, sidecarReady, t],
	);

	useEffect(() => {
		if (!open) setReadSince(generation);
	}, [open, generation]);

	useEffect(() => {
		if (!open) return undefined;
		setQuery("");
		setPickedGroup(null);
		setOpenRouterExpanded(false);
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
		void load(false);
		return () => {
			requestVersion.current++;
			setReadSince(useModelStore.getState().catalogGeneration);
		};
	}, [open, load]);

	const hasOpenRouter = availableModels.some(model => model.provider === "openrouter");
	useEffect(() => {
		if (!open || !sidecarReady || !hasOpenRouter) return undefined;
		let cancelled = false;
		void tabRpc
			.getModelReleaseDates()
			.then(response => {
				if (cancelled || !response.success) return;
				const data = response.data as ModelReleaseDatesResult | undefined;
				setReleaseDates(new Map(Object.entries(data?.dates ?? {})));
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open, sidecarReady, hasOpenRouter, tabRpc]);

	// The picker opens over the focused session's composer, its right edge on the composer's (the model chip's
	// side), and leaves the window as it is behind it. Without a composer on screen (a page open) it opens at the top.
	const [anchor, setAnchor] = useState<ModalAnchor | null>(null);
	useLayoutEffect(() => {
		if (!open) return undefined;
		const measure = () => {
			const box = document
				.querySelector('.omp-session-pane[data-active="true"] .omp-composer-box')
				?.getBoundingClientRect();
			setAnchor(box && box.width > 0 && box.height > 0 ? { top: box.top, right: box.right } : null);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open]);

	// Stock's MRU order; an omp without it (or a failed read) just shows no Recent group.
	useEffect(() => {
		if (!open || !sidecarReady) return undefined;
		let cancelled = false;
		void tabRpc
			.getRecentModels()
			.then(response => {
				const data = response.success ? response.data : undefined;
				const selectors =
					data && typeof data === "object" && "selectors" in data && Array.isArray(data.selectors)
						? data.selectors.filter((selector): selector is string => typeof selector === "string")
						: [];
				if (!cancelled) setRecentSelectors(selectors);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open, sidecarReady, tabRpc]);

	const nameByProvider = useMemo(
		() =>
			new Map(
				catalogProviders.map(({ id, name }) => {
					return [id, modelProviderGroup(id) === "anthropic-api-key" ? claudeApiKeyLabel(id, name, t) : name];
				}),
			),
		[catalogProviders, t],
	);
	const connected = useMemo(
		() => new Set(catalogProviders.filter(p => p.authenticated && !p.disabled).map(p => p.id)),
		[catalogProviders],
	);
	const providerTabs = useMemo(
		() =>
			[...new Set(Array.from(connected, modelProviderGroup))].map(id => {
				const api = id === "anthropic-api-key";
				const auth = catalogProviders.find(p => p.id === id)?.authKind;
				const label = api
					? t("modelPicker.claudeApi")
					: id === "anthropic" && auth === "oauth"
						? t("modelPicker.claudeSubscription")
						: (nameByProvider.get(id) ?? id);
				return {
					id,
					label,
					tooltip: label,
					className: "w-9 justify-center [&>.truncate]:sr-only",
					leading: (
						<span aria-hidden className="relative">
							<ProviderMark className="size-4" provider={{ id: api ? "anthropic" : id, name: label }} />
							{(api || auth === "apikey") && (
								<KeyRound className="absolute -right-1.5 -bottom-1 size-3 rounded-sm bg-(--sc-elevated)" />
							)}
						</span>
					),
				};
			}),
		[catalogProviders, connected, nameByProvider, t],
	);
	const preferredGroup = pickedGroup ?? (current && modelProviderGroup(current.provider));
	const activeGroup = providerTabs.find(tab => tab.id === preferredGroup)?.id ?? providerTabs[0]?.id;
	const visibleFailures =
		activeGroup === "anthropic-api-key" ? [...failedKeys.values()].filter(s => connected.has(s.provider)) : [];
	const labels = useMemo(() => compactModelLabels(availableModels), [availableModels]);

	const groups = useMemo((): PickerGroup[] => {
		const q = query.trim().toLowerCase();
		const filtered = availableModels.filter(
			model =>
				connected.has(model.provider) &&
				modelProviderGroup(model.provider) === activeGroup &&
				(q.length === 0 ||
					model.id.toLowerCase().includes(q) ||
					model.provider.toLowerCase().includes(q) ||
					(nameByProvider.get(model.provider)?.toLowerCase().includes(q) ?? false) ||
					model.name?.toLowerCase().includes(q) ||
					model.description?.toLowerCase().includes(q)),
		);
		const byProvider = groupModelsByProvider(filtered, catalogProviders).map(
			({ provider, models }): PickerGroup => ({
				id: provider,
				provider,
				models:
					provider === "openrouter"
						? [...models].sort((a, b) => {
								const aRelease = releaseDates.get(a.id);
								const bRelease = releaseDates.get(b.id);
								const aDate = typeof aRelease === "number" && Number.isFinite(aRelease) ? aRelease : -Infinity;
								const bDate = typeof bRelease === "number" && Number.isFinite(bRelease) ? bRelease : -Infinity;
								return bDate === aDate ? 0 : bDate > aDate ? 1 : -1;
							})
						: models,
				collapsed: provider === "openrouter" && !q && !openRouterExpanded,
			}),
		);
		let auto: PickerGroup | undefined;
		if (activeGroup === "anthropic-api-key" && byProvider.length > 1) {
			const first = new Map<string, ModelInfo>();
			const shared = new Map<string, ModelInfo>();
			for (const group of byProvider) {
				for (const model of group.models) {
					if (model.pickerAvailability !== "account-verified") continue;
					const previous = first.get(model.id);
					if (!previous) first.set(model.id, model);
					else if (previous.provider !== model.provider) shared.set(model.id, previous);
				}
			}
			if (shared.size) auto = { id: AUTO_GROUP, provider: null, models: [...shared.values()], collapsed: false };
		}
		if (q.length > 0) return auto ? [auto, ...byProvider] : byProvider;
		const bySelector = new Map(filtered.map(model => [`${model.provider}/${model.id}`, model]));
		const recent = recentSelectors.flatMap(selector => bySelector.get(selector) ?? []).slice(0, RECENT_LIMIT);
		const currentModel =
			current?.provider === "openrouter" ? bySelector.get(`${current.provider}/${current.id}`) : undefined;
		return [
			...(auto ? [auto] : []),
			...(currentModel ? [{ id: CURRENT_GROUP, provider: null, models: [currentModel], collapsed: false }] : []),
			...(recent.length > 0 ? [{ id: RECENT_GROUP, provider: null, models: recent, collapsed: false }] : []),
			...byProvider,
		];
	}, [
		availableModels,
		activeGroup,
		connected,
		current,
		nameByProvider,
		catalogProviders,
		openRouterExpanded,
		query,
		recentSelectors,
		releaseDates,
	]);

	const waitingForModels = loading && availableModels.length === 0;
	const showOptions = !error && !waitingForModels && groups.length > 0;

	// Flat row order (group order → in-group order) for keyboard navigation; a
	// recent model also listed under its provider is a separate row.
	const flatOptions = useMemo(
		() =>
			showOptions
				? groups.flatMap(group =>
						(group.collapsed ? [] : group.models).map(model => ({
							provider: model.provider,
							modelId: model.id,
							model,
							auto: group.id === AUTO_GROUP,
							key: `${group.id}:${model.provider}/${model.id}`,
						})),
					)
				: [],
		[groups, showOptions],
	);
	const indexByKey = useMemo(() => new Map(flatOptions.map((option, index) => [option.key, index])), [flatOptions]);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, flatOptions.length - 1)));
	}, [flatOptions.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const isOverContext = (model: ModelInfo): boolean => {
		const tokens = contextUsage?.tokens ?? 0;
		const contextWindow = model.contextWindow ?? 0;
		return tokens > 0 && contextWindow > 0 && tokens > contextWindow;
	};

	/** The full name and secondary facts of a row, said once under the list for the highlighted row. */
	const describeModel = (model: ModelInfo): string => {
		const key = `${model.provider}/${model.id}`;
		const isCurrent = current?.provider === model.provider && current.id === model.id;
		const compaction = compactionPoints?.bySelector.get(key);
		const compactionValue = compaction ? compactionPointValue(compaction) : null;
		return [
			modelDisplayName(model),
			model.name && model.name !== model.id ? model.id : null,
			model.description,
			model.int != null && Number.isFinite(model.int)
				? t("modelPicker.intelligence", { value: Math.round(model.int) })
				: null,
			model.tps != null && Number.isFinite(model.tps) && model.tps > 0
				? t("modelPicker.speed", { value: model.tps >= 10 ? Math.round(model.tps) : model.tps.toFixed(1) })
				: null,
			compaction
				? compactionValue === null
					? t("compactionLimits.compactsOff")
					: t("compactionLimits.compactsAt", { value: compactionValue })
				: null,
			model.contextWindow != null && model.contextWindow < MIN_SERVING_CONTEXT
				? t("modelPicker.smallContextHint")
				: null,
			!isCurrent && isOverContext(model)
				? t("modelPicker.overContextHint", {
						current: formatTokens(contextUsage?.tokens),
						limit: formatTokens(model.contextWindow),
					})
				: null,
		]
			.filter(Boolean)
			.join(" · ");
	};

	const select = async (provider: string, modelId: string, auto: boolean) => {
		if (!sidecarReady) return;
		const key = `${provider}/${modelId}`;
		setSwitching(key);
		try {
			const target = availableModels.find(m => m.provider === provider && m.id === modelId);
			// TUI parity: picking a model whose context window is smaller than the
			// live session usage compacts with the CURRENT model first, then
			// switches. The row carries the over-context warning before the pick.
			const overContext = target !== undefined && isOverContext(target);
			if (overContext) {
				const {
					response: compactRes,
					cancelled,
					skipped,
				} = await runManualMaintenance("compact", () => tabRpc.compact(), tabId);
				if (cancelled) {
					toast({ variant: "info", message: t("command.compactCancelled") });
					return;
				}
				// Nothing to compact (said already): the switch the person asked for still goes ahead.
				if (!skipped && !compactRes.success) {
					toastError({ title: t("modelPicker.compactFailed"), error: compactRes });
					return;
				}
				if (!skipped) toast({ variant: "info", message: t("modelPicker.compactedSwitching") });
			}
			const response = auto
				? await tabRpc.command({ type: "set_claude_api_auto_model", modelId })
				: await tabRpc.setModel(provider, modelId);
			if (!response.success) {
				toastError({ title: t("modelPicker.failed"), error: response });
				return;
			}
			// The response carries the sidecar's live model. Applying it here covers
			// the switch that emits no model_changed at all — re-picking the current
			// model is a server-side no-op, so the event channel can never heal a
			// stale label.
			if (tabId) applyModelInfo(response.data, tabId, { picked: true });
			// Compaction rewrote the transcript — rehydrate so the chat and the
			// context bar reflect the compacted session, not just the new model.
			if (overContext) await hydrateSession();
			close();
		} catch (cause) {
			toastError({ title: t("modelPicker.failed"), error: cause });
		} finally {
			setSwitching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		const target = listboxTarget(event.key, activeIndex, flatOptions.length, { wrap: false });
		if (target !== null) {
			event.preventDefault();
			setActiveIndex(target);
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			const option = flatOptions[activeIndex];
			if (option) void select(option.provider, option.modelId, option.auto);
		}
	};

	const manageProviders = () => {
		close();
		openProviders();
	};

	const activeModel = showOptions ? flatOptions[activeIndex]?.model : undefined;
	const activeDetail = activeModel ? describeModel(activeModel) : "";
	const detailId = `${listboxId}-detail`;

	return (
		<Modal
			anchor={anchor}
			ariaLabel={t("modelPicker.searchLabel")}
			backdrop={false}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement={anchor ? "above" : "top"}
			size="picker-compact"
		>
			<div className="flex h-full min-h-0 flex-col">
				{activeGroup && (
					<Tabs
						ariaLabel={t("modelCompare.providerFilter")}
						className="shrink-0 px-1.5"
						activeId={activeGroup}
						tabs={providerTabs}
						onChange={(id, via) => {
							setPickedGroup(id);
							setQuery("");
							setActiveIndex(0);
							if (via === "click") inputRef.current?.focus();
						}}
					/>
				)}
				<div className="flex items-center gap-1 border-b border-(--sc-divider) p-1.5">
					<div className="min-w-0 flex-1">
						<SearchField
							listbox={{
								id: listboxId,
								activeId: flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined,
							}}
							aria-describedby={activeDetail ? detailId : undefined}
							controlSize="sm"
							label={t("modelPicker.searchLabel")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("modelPicker.placeholder")}
							ref={inputRef}
							value={query}
						/>
					</div>
					{/* Asks the providers again (Orca's `AgentPickerRefreshModelsButton.tsx`): a model the account just gained shows. */}
					<IconButton
						data-model-refresh
						disabled={!sidecarReady}
						disabledReason={t("modelPicker.notConnected")}
						icon={<RefreshCw />}
						label={t("modelPicker.refresh")}
						loading={refreshing}
						onClick={() => {
							setRefreshing(true);
							void load(true).finally(() => setRefreshing(false));
						}}
						size="sm"
						variant="ghost"
					/>
				</div>
				{!error &&
					visibleFailures.map(({ provider, fetchedAt }) => (
						<div key={provider} className="px-2 py-1 text-sc-sm">
							<strong>{nameByProvider.get(provider) ?? provider}</strong>
							<KeyQueryFailure
								account={nameByProvider.get(provider) ?? provider}
								disabled={!sidecarReady}
								fetchedAt={fetchedAt}
								provider={provider}
							/>
						</div>
					))}
				{unconfirmed && !error && (
					<InlineNotice
						action={
							<Button
								disabled={!sidecarReady}
								disabledReason={t("modelPicker.notConnected")}
								onClick={() => void load(true)}
								size="sm"
							>
								{t("common.retry")}
							</Button>
						}
						className="px-2"
						title={t("modelPicker.accountUnverified")}
						tone="warning"
					/>
				)}
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<InlineNotice
							action={
								<Button
									disabled={!sidecarReady}
									disabledReason={t("modelPicker.notConnected")}
									onClick={() => void load(true, t("modelPicker.stillNotResponding"))}
									size="sm"
								>
									{t("common.retry")}
								</Button>
							}
							className="px-2"
							detail={error.cause}
							title={
								<>
									{error.message}
									<span className="block text-sc-xs text-(--sc-text-muted)">
										{t("modelPicker.notRespondingHint")}
									</span>
								</>
							}
							tone="danger"
						/>
					) : (visibleFailures.length > 0 && groups.length === 0) ||
						(unconfirmed && availableModels.length === 0) ? null : waitingForModels ? (
						<SkeletonRows className="py-2" label={t("modelPicker.loading")} widths={[60, 44, 70, 52]} />
					) : !activeGroup || availableModels.length === 0 ? (
						<EmptyState
							actions={
								<Button onClick={manageProviders} size="sm" variant="primary">
									{t("modelPicker.connectProvider")}
								</Button>
							}
							size="sm"
							title={t("modelPicker.empty")}
						/>
					) : groups.length === 0 ? (
						<EmptyState
							size="sm"
							title={query.trim() ? t("modelPicker.noMatch", { query }) : t("modelPicker.empty")}
						/>
					) : (
						<>
							{!sidecarReady && (
								<InlineNotice className="px-2" title={t("modelPicker.notConnected")} tone="warning" />
							)}
							{groups.map(({ id: groupId, provider, models, collapsed }) => {
								const groupName =
									provider === null
										? t(
												groupId === AUTO_GROUP
													? "modelPicker.claudeApiAuto"
													: groupId === CURRENT_GROUP
														? "modelPicker.current"
														: "modelPicker.recent",
											)
										: (nameByProvider.get(provider) ?? provider);
								return (
									<OptionGroup
										action={
											provider === "openrouter" &&
											!query.trim() && (
												<DisclosureButton
													aria-label={groupName}
													inline
													onToggle={() => setOpenRouterExpanded(value => !value)}
													open={!collapsed}
												>
													{models.length}
												</DisclosureButton>
											)
										}
										className={
											groups.length === 1 && provider !== "openrouter" && activeGroup !== "anthropic-api-key"
												? "[&>[data-option-group-header]]:hidden"
												: undefined
										}
										data-model-group={groupId}
										key={groupId}
										label={groupName}
									>
										<Collapse open={!collapsed}>
											{models.map(model => {
												const key = `${model.provider}/${model.id}`;
												const auto = groupId === AUTO_GROUP;
												const isCurrent =
													current?.id === model.id &&
													(auto
														? autoRoute?.provider === current.provider
														: current.provider === model.provider && !autoRoute);
												const optionIndex = indexByKey.get(`${groupId}:${key}`);
												const isActive = optionIndex !== undefined && optionIndex === activeIndex;
												const over = !isCurrent && isOverContext(model);
												const small =
													model.contextWindow != null && model.contextWindow < MIN_SERVING_CONTEXT;
												const label = labels.get(key) ?? { name: modelDisplayName(model) };
												const apiKey = modelProviderGroup(model.provider) === "anthropic-api-key";
												const suffix = auto
													? undefined
													: apiKey
														? provider === null
															? nameByProvider.get(model.provider)
															: label.suffix?.replace(model.provider, "").trim()
														: label.suffix;
												return (
													<OptionRow
														active={isActive}
														data-model-option
														data-option-index={optionIndex}
														disabled={switching !== null || !sidecarReady}
														key={key}
														id={
															optionIndex === undefined
																? undefined
																: `${listboxId}-option-${optionIndex}`
														}
														onClick={() => void select(model.provider, model.id, auto)}
														onMouseEnter={() => {
															if (optionIndex !== undefined) setActiveIndex(optionIndex);
														}}
														pointerMoves
														selected={isCurrent}
														size="xs"
													>
														<ProviderMark
															className="size-4"
															provider={{
																id: apiKey ? "anthropic" : model.provider,
																name: nameByProvider.get(model.provider) ?? model.provider,
															}}
														/>
														<span
															className={cx(
																"flex min-w-0 flex-1 items-baseline gap-1.5 text-sc-sm",
																isCurrent ? "font-medium text-(--sc-text)" : "text-(--sc-text)",
																over && "text-(--sc-text-muted)",
															)}
														>
															<span className="min-w-0 truncate">{label.name}</span>
															{suffix && (
																<span className="shrink-0 text-sc-2xs font-normal text-(--sc-text-muted) tabular-nums">
																	{suffix}
																</span>
															)}
														</span>
														{model.isRecommended && (
															<Badge variant="accent">{t("modelPicker.badge.recommended")}</Badge>
														)}
														{model.isNew && <Badge variant="info">{t("modelPicker.badge.new")}</Badge>}
														{model.isBeta && (
															<Badge variant="warning">{t("modelPicker.badge.beta")}</Badge>
														)}
														{model.contextWindow != null && (
															<span
																className={cx(
																	"shrink-0 text-sc-2xs tabular-nums",
																	small ? "text-(--sc-warning)" : "text-(--sc-text-muted)",
																)}
															>
																{formatTokens(model.contextWindow, { trimZero: true })}
															</span>
														)}
														{over && (
															<span
																aria-label={t("modelPicker.overContext")}
																className="flex shrink-0 text-(--sc-warning)"
																role="img"
															>
																<TriangleAlert aria-hidden className="size-(--sc-icon-sm)" />
															</span>
														)}
														{switching === key && <Spinner size="sm" spin />}
														{isCurrent && (
															<Check
																aria-label={t("modelPicker.current")}
																className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)"
															/>
														)}
													</OptionRow>
												);
											})}
										</Collapse>
									</OptionGroup>
								);
							})}
						</>
					)}
				</div>
				{/* The highlighted row's facts, where the keyboard is: the rows never take focus (the field drives them). */}
				{activeDetail && (
					<p
						className="line-clamp-2 border-t border-(--sc-divider) px-3 py-1.5 text-sc-xs break-words text-(--sc-text-muted) [html[data-input=touch]_&]:hidden"
						data-model-picker-detail
						id={detailId}
					>
						{activeDetail}
					</p>
				)}
				{/* Model and effort in one place: the segmented thinking row for the model in use (two taps from the
				    model chip). Picking a model closes the dialog, so the row is for the current one. */}
				{supportsThinking && (
					<div className="border-t border-(--sc-divider) px-3 py-2" data-model-picker-thinking>
						<ThinkingLevelField variant="segmented" />
					</div>
				)}
				<KeyHints
					data-model-picker-footer
					hints={[
						{ keys: ["↑", "↓"], label: t("modelPicker.keys.move") },
						{ keys: ["↵"], label: t("modelPicker.keys.pick") },
					]}
				>
					<SettingInfo text={t("modelPicker.sessionOnlyHint")} />
					<Button icon={<Settings2 />} onClick={manageProviders} size="sm" variant="ghost">
						{t("modelPicker.manageProviders")}
					</Button>
				</KeyHints>
			</div>
		</Modal>
	);
}
