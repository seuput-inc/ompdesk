/**
 * Bot templates (Orca's `templates/BotTemplatesDialog.tsx:1-337`, `BotTemplateRow.tsx`, `BotTemplateDetail.tsx:28-110`,
 * `BotTemplateComesWith.tsx`, `BotTemplatesEmpty.tsx`): a searchable list by category beside the chosen template's
 * detail (one pane at a time on a narrow window, with "All templates" back). `/` focuses the search, ↑/↓ choose,
 * Enter or a double click uses the template (New bot, prefilled), Escape clears the search first. The last chosen
 * template is remembered. Nothing found offers a blank bot for what was typed.
 */
import { CalendarClock, ChevronLeft, LayoutGrid, Plug, Plus, Sparkles, Zap } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useCurrentLang, useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { botTemplateWords } from "../../locales/bot-templates";
import { useBotsStore } from "../../stores/bots";
import {
	Badge,
	Button,
	Card,
	Chip,
	EmptyState,
	Modal,
	OptionGroup,
	OptionRow,
	SearchField,
	SectionLabel,
	useMasterDetail,
} from "../common";
import { BotAvatar } from "./BotAvatar";
import { openBotDialog } from "./bot-launch";
import {
	BOT_TEMPLATE_CATEGORIES,
	BOT_TEMPLATES,
	type BotTemplate,
	type BotTemplateCategory,
	templateMatches,
} from "./bot-templates";
import { freeBotName } from "./bot-view";

const SELECTED_KEY = "omp.bots.templateSelected";

export function BotTemplatesDialog({
	initialQuery = "",
	initialSelected,
	onClose,
}: {
	initialQuery?: string;
	initialSelected?: string;
	onClose: () => void;
}) {
	const t = useT();
	const lang = useCurrentLang();
	const listId = useId();
	const bots = useBotsStore(s => s.state.bots);
	const searchRef = useRef<HTMLInputElement>(null);
	const [query, setQuery] = useState(initialQuery);
	const [category, setCategory] = useState<BotTemplateCategory | null>(null);
	const [selected, setSelected] = useState(
		() => initialSelected ?? localStorage.getItem(SELECTED_KEY) ?? BOT_TEMPLATES[0]?.id ?? "",
	);
	const [detailOpen, setDetailOpen] = useState(Boolean(initialSelected));
	const nameOf = (template: BotTemplate) => botTemplateWords(lang, template.id).name;
	const lineOf = (template: BotTemplate) => botTemplateWords(lang, template.id).line;
	const shown = useMemo(
		() =>
			BOT_TEMPLATES.filter(
				template =>
					(!category || template.category === category) &&
					templateMatches(
						template,
						[
							botTemplateWords(lang, template.id).name,
							botTemplateWords(lang, template.id).line,
							t(`bots.templates.category.${template.category}`),
							// English still finds a translated name (Orca's bot-template-view.ts:46-70).
							template.id.replaceAll("-", " "),
						].join(" "),
						query,
					),
			),
		[category, query, t, lang],
	);
	const current = shown.find(template => template.id === selected) ?? shown[0];
	useEffect(() => {
		if (current) localStorage.setItem(SELECTED_KEY, current.id);
	}, [current]);
	const { showList, showDetail } = useMasterDetail(detailOpen, () => setDetailOpen(false));

	const use = (template: BotTemplate) => {
		const line = lineOf(template);
		openBotDialog({
			kind: "new",
			draft: { name: freeBotName(nameOf(template), bots), purpose: line, template: { template, line } },
		});
	};
	const move = (delta: number) => {
		if (shown.length === 0) return;
		const at = Math.max(
			0,
			shown.findIndex(template => template.id === current?.id),
		);
		const next = shown[(at + delta + shown.length) % shown.length];
		if (next) setSelected(next.id);
		document.getElementById(`${listId}-${next?.id}`)?.scrollIntoView({ block: "nearest" });
	};

	return (
		<Modal
			ariaLabel={t("bots.templates.title")}
			bodyClassName="p-0"
			onClose={onClose}
			open
			size="lg"
			title={t("bots.templates.title")}
		>
			<div
				className="flex h-[min(70vh,640px)] min-h-0"
				data-bot-templates
				onKeyDown={event => {
					if (event.key === "/" && document.activeElement !== searchRef.current) {
						event.preventDefault();
						searchRef.current?.focus();
					}
				}}
			>
				{showList && (
					<div className="flex min-h-0 w-full min-w-0 flex-col border-(--sc-border-subtle) md:w-[44%] md:border-r">
						<div className="flex flex-col gap-2 p-3">
							<div className="flex items-center gap-2">
								<SearchField
									autoFocus
									className="min-w-0 flex-1"
									label={t("bots.templates.search")}
									listbox={{ id: listId, activeId: current ? `${listId}-${current.id}` : undefined }}
									onKeyDown={event => {
										if (isImeKeyEvent(event)) return;
										if (event.key === "ArrowDown" || event.key === "ArrowUp") {
											event.preventDefault();
											move(event.key === "ArrowDown" ? 1 : -1);
										} else if (event.key === "Enter" && current) {
											event.preventDefault();
											use(current);
										}
									}}
									onValueChange={setQuery}
									placeholder={t("bots.templates.search")}
									ref={searchRef}
									value={query}
								/>
								<Button
									icon={<Plus />}
									onClick={() => openBotDialog({ kind: "new" })}
									size="sm"
									variant="secondary"
								>
									{t("bots.templates.blank")}
								</Button>
							</div>
							<div aria-label={t("bots.templates.filter")} className="flex flex-wrap gap-1" role="group">
								<Chip onPressedChange={() => setCategory(null)} pressed={category === null}>
									<LayoutGrid aria-hidden className="size-3" />
									{t("bots.templates.category.all")}
								</Chip>
								{BOT_TEMPLATE_CATEGORIES.map(id => (
									<Chip key={id} onPressedChange={() => setCategory(id)} pressed={category === id}>
										{t(`bots.templates.category.${id}`)}
									</Chip>
								))}
							</div>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" id={listId} role="listbox">
							{shown.length === 0 ? (
								<EmptyState
									actions={
										<>
											<Button
												onClick={() => openBotDialog({ kind: "new", draft: { purpose: query } })}
												size="sm"
												variant="secondary"
											>
												{t("bots.templates.blankFor", { query })}
											</Button>
											<Button onClick={() => setQuery("")} size="sm" variant="ghost">
												{t("common.clearSearch")}
											</Button>
										</>
									}
									size="sm"
									title={t("bots.templates.none", { query })}
								/>
							) : (
								BOT_TEMPLATE_CATEGORIES.map(id => {
									const rows = shown.filter(template => template.category === id);
									if (rows.length === 0) return null;
									return (
										<OptionGroup key={id} label={t(`bots.templates.category.${id}`)} sticky>
											{rows.map(template => (
												<OptionRow
													active={template.id === current?.id}
													data-bot-template={template.id}
													id={`${listId}-${template.id}`}
													key={template.id}
													onClick={() => {
														setSelected(template.id);
														setDetailOpen(true);
													}}
													onDoubleClick={() => use(template)}
												>
													<BotAvatar bot={{ name: nameOf(template), id: template.id }} size={28} />
													<span className="flex min-w-0 flex-1 flex-col">
														<span className="flex items-center gap-1.5 text-sc-sm">
															<span className="truncate">{nameOf(template)}</span>
															{template.needsSetup && (
																<Badge size="xs" variant="warning">
																	{t("bots.templates.needsSetup")}
																</Badge>
															)}
														</span>
														<span className="truncate text-sc-xs text-(--sc-text-muted)">
															{lineOf(template)}
														</span>
													</span>
												</OptionRow>
											))}
										</OptionGroup>
									);
								})
							)}
						</div>
					</div>
				)}
				{showDetail && current && (
					<TemplateDetail onBack={() => setDetailOpen(false)} onUse={() => use(current)} template={current} />
				)}
			</div>
		</Modal>
	);
}

function TemplateDetail({ template, onUse, onBack }: { template: BotTemplate; onUse: () => void; onBack: () => void }) {
	const t = useT();
	const words = botTemplateWords(useCurrentLang(), template.id);
	const name = words.name;
	return (
		<div
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
			data-bot-template-detail={template.id}
		>
			<Button className="self-start md:hidden" icon={<ChevronLeft />} onClick={onBack} size="sm" variant="ghost">
				{t("bots.templates.all")}
			</Button>
			<div className="flex items-center gap-3">
				<BotAvatar bot={{ name, id: template.id }} size={56} />
				<div className="min-w-0">
					<h3 className="text-sc-md font-semibold text-(--sc-text)">{name}</h3>
					<p className="text-sc-xs text-(--sc-text-muted)">
						{t("bots.templates.by", { category: t(`bots.templates.category.${template.category}`) })}
					</p>
				</div>
			</div>
			<p className="text-sc-sm text-(--sc-text)">{words.line}</p>
			<Button className="self-start" data-bot-template-use onClick={onUse} variant="primary">
				{t("bots.templates.use")}
			</Button>
			<Card padding="md">
				<SectionLabel as="h4">{t("bots.templates.sample", { name })}</SectionLabel>
				<p className="mt-1 text-sc-sm text-(--sc-text)">{words.example}</p>
			</Card>
			<section>
				<SectionLabel as="h4">{t("bots.templates.firstChat")}</SectionLabel>
				<p className="mt-1 text-sc-sm text-(--sc-text)">{words.first}</p>
			</section>
			{template.needsSetup && (
				<Card padding="md" surface="code">
					<SectionLabel as="h4">{t("bots.templates.needsSetup")}</SectionLabel>
					<p className="mt-1 text-sc-sm text-(--sc-text-muted)">{t("bots.templates.needsSetupText")}</p>
				</Card>
			)}
			<section className="flex flex-col gap-1.5">
				<SectionLabel as="h4">{t("bots.templates.comesWith")}</SectionLabel>
				<ul className="flex flex-col gap-1 text-sc-sm">
					{template.skills.map(id => (
						<li className="flex items-center gap-2" key={id}>
							<Sparkles aria-hidden className="size-3.5 shrink-0 text-(--sc-text-muted)" />
							<span className="font-mono text-sc-xs">{id}</span>
							<span className="ml-auto text-sc-xs text-(--sc-text-muted)">{t("bots.templates.skill")}</span>
						</li>
					))}
					{template.routines.map(routine => (
						<li className="flex items-center gap-2" key={routine.label}>
							<CalendarClock aria-hidden className="size-3.5 shrink-0 text-(--sc-text-muted)" />
							<span>{routine.label}</span>
							<span className="ml-auto text-sc-xs text-(--sc-text-muted)">{t("bots.templates.off")}</span>
						</li>
					))}
					{template.events.map(event => (
						<li className="flex items-center gap-2" key={event}>
							<Zap aria-hidden className="size-3.5 shrink-0 text-(--sc-text-muted)" />
							<span className="min-w-0">{event}</span>
							<span className="ml-auto shrink-0 text-sc-xs text-(--sc-text-muted)">
								{t("bots.templates.inFirstChat")}
							</span>
						</li>
					))}
					{template.connectors.map(connector => (
						<li className="flex items-center gap-2" key={connector}>
							<Plug aria-hidden className="size-3.5 shrink-0 text-(--sc-text-muted)" />
							<span>{t(`bots.connector.${connector}`)}</span>
							<span className="ml-auto text-sc-xs text-(--sc-text-muted)">
								{t("bots.templates.notConnected")}
							</span>
						</li>
					))}
				</ul>
			</section>
		</div>
	);
}
