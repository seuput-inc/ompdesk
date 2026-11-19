/**
 * Theme picker: searchable overlay of the five theme sets. Each set has three rows: the set itself, which follows
 * the OS between its halves, then its light and its dark theme, which stay. Each row shows a live swatch preview
 * from the theme's token set. Selecting a row applies it live (inline `--omp-*` tokens), persists the choice, and
 * keeps the legacy dark/light/system store coherent so the App effect and the settings window stay in sync.
 */

import { Check } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { THEME_SETS } from "../../../shared/theme-names";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { listboxTarget } from "../../lib/listbox-nav";
import {
	applyThemeSet,
	getPersistedThemeSelection,
	THEMES,
	type ThemeSetChoice,
	themeSetChoice,
} from "../../lib/themes";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { EmptyState, Modal, OptionRow, SearchField } from "../common";
import { ThemePreview, ThemeSetPreview } from "../settings/ThemePicker";

interface ThemeEntry {
	/** The set's id for the row that follows the OS, the theme's id for a row that stays on one half. */
	id: string;
	choice: ThemeSetChoice;
	preview: ReactNode;
	label: string;
	description: string;
}

export function ThemePickerDialog() {
	const t = useT();
	const open = useUiStore(s => s.themePickerOpen);
	const close = useUiStore(s => s.closeThemePicker);
	const setTheme = useUiStore(s => s.setTheme);

	const [query, setQuery] = useState("");
	const [current, setCurrent] = useState<ThemeSetChoice | null>(null);
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	const entries = useMemo<ThemeEntry[]>(
		() =>
			THEME_SETS.flatMap(set => [
				{
					id: set.id,
					choice: { set: set.id, mode: "system" },
					preview: <ThemeSetPreview set={set} />,
					label: t(`themePicker.set.${set.id}.label`),
					description: t("themePicker.systemDesc"),
				},
				...(["light", "dark"] as const).map(mode => ({
					id: set[mode],
					choice: { set: set.id, mode },
					preview: <ThemePreview theme={THEMES[set[mode]]} />,
					label: t(`themePicker.theme.${set[mode]}.label`),
					description: t(`themePicker.theme.${set[mode]}.description`),
				})),
			]),
		[t],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(e => e.label.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
	}, [entries, query]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setQuery("");
		setActive(0);
		void getPersistedThemeSelection().then(sel => {
			if (cancelled) return;
			const choice = themeSetChoice(sel);
			setCurrent(choice);
			// Three rows a set: the set, its light theme, its dark theme.
			const row = ["system", "light", "dark"].indexOf(choice.mode);
			setActive(THEME_SETS.findIndex(set => set.id === choice.set) * 3 + row);
		});
		requestAnimationFrame(() => inputRef.current?.focus());
		return () => {
			cancelled = true;
		};
	}, [open]);

	const select = (entry: ThemeEntry) => {
		applyThemeSet(entry.choice);
		setTheme(entry.choice.mode);
		setCurrent(entry.choice);
		toast({ variant: "success", message: t("themePicker.applied", { name: entry.label }) });
		close();
	};

	const onKey = (e: React.KeyboardEvent) => {
		if (isImeKeyEvent(e)) return;
		const target = listboxTarget(e.key, active, filtered.length, { wrap: false });
		if (target !== null) {
			e.preventDefault();
			setActive(target);
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = filtered[active];
			if (entry) select(entry);
		}
	};

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	return (
		<Modal
			open={open}
			onClose={close}
			chromeless
			ariaLabel={t("themePicker.aria")}
			size="picker"
			placement="top"
			bodyClassName="p-0"
		>
			<div onKeyDown={onKey}>
				<div className="border-b border-(--sc-divider) p-4">
					<SearchField
						controlSize="lg"
						label={t("themePicker.search")}
						listbox={{
							id: listboxId,
							activeId: filtered.length > 0 ? `${listboxId}-option-${active}` : undefined,
						}}
						onValueChange={value => {
							setQuery(value);
							setActive(0);
						}}
						placeholder={t("themePicker.search")}
						ref={inputRef}
						value={query}
					/>
				</div>
				<div
					aria-label={t("themePicker.aria")}
					className="omp-command-list overflow-y-auto p-2"
					id={listboxId}
					ref={listRef}
					role={filtered.length > 0 ? "listbox" : undefined}
				>
					{filtered.length === 0 && <EmptyState size="sm" title={t("themePicker.empty")} />}
					{filtered.map((entry, i) => (
						<OptionRow
							key={entry.id}
							active={i === active}
							className="gap-3"
							data-index={i}
							data-theme-entry={entry.id}
							id={`${listboxId}-option-${i}`}
							onClick={() => select(entry)}
							onMouseDown={event => event.preventDefault()}
							onMouseEnter={() => setActive(i)}
							pointerMoves
						>
							<span
								aria-hidden="true"
								className="flex h-14 w-28 shrink-0 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-border-subtle)"
							>
								{entry.preview}
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex flex-wrap items-center gap-2 text-sc-md font-medium text-(--sc-text)">
									{entry.label}
									{entry.choice.set === current?.set && entry.choice.mode === current.mode && (
										<>
											<Check aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-secondary)" />
											<span className="sr-only">{t("tabSwitcher.current")}</span>
										</>
									)}
								</span>
								<span className="block text-sc-sm leading-relaxed text-(--sc-text-muted)">
									{entry.description}
								</span>
							</span>
						</OptionRow>
					))}
				</div>
			</div>
		</Modal>
	);
}
