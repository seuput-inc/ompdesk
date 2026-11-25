/**
 * A pull request's or an issue's people and labels: requested reviewers (a PR only), assignees and labels, each a row
 * of chips with a ✕ and an add picker fed by the repository's assignable people and labels (Orca
 * `pull-request-page/reviewers/*`, `PRAssigneesPanel.tsx`, `edit-item-fields/gh-edit-section-*.tsx`). Every change is
 * one `people` write and the item reads again. `useAssignable` also feeds the @mention list of the Markdown boxes
 * (Orca `github-mention-option-filter`): one read per repository, kept for the window's life.
 */
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { GithubPeople, GithubTarget } from "../../../../shared/github";
import { useFocusedScope } from "../../../lib/focused-scope";
import { github } from "../../../lib/github";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { toastError } from "../../../stores/toast";
import { Chip, IconButton, OptionRow, Popover, SearchField } from "../../common";

type Field = "reviewers" | "assignees" | "labels";

/** One read of a repository's people or labels per window: the pickers and @ lists share it. */
const choices = new Map<string, Promise<string[]>>();

function readChoices(key: string, read: () => Promise<string[]>): Promise<string[]> {
	let found = choices.get(key);
	if (!found) {
		found = read().catch(error => {
			choices.delete(key);
			throw error;
		});
		choices.set(key, found);
	}
	return found;
}

function targetKey(cwd: string, target: GithubTarget, op: string): string {
	return `${cwd}\n${target.host ?? ""}\n${target.repo ?? ""}\n${op}`;
}

/** The logins that can be assigned or @mentioned in `target`'s repository; empty until read (or when it failed). */
export function useAssignable(target: GithubTarget = {}): string[] {
	const { cwd } = useFocusedScope();
	const { host, repo } = target;
	const [logins, setLogins] = useState<string[]>([]);
	useEffect(() => {
		let live = true;
		const named = { ...(host ? { host } : {}), ...(repo ? { repo } : {}) };
		readChoices(targetKey(cwd, named, "assignable"), () => github({ op: "assignable", ...named })).then(
			found => live && setLogins(found),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [cwd, host, repo]);
	return logins;
}

function ChoicePicker({
	field,
	target,
	taken,
	onPick,
}: {
	field: Field;
	target: GithubTarget;
	taken: readonly string[];
	onPick: (value: string) => void;
}) {
	const t = useT();
	const { cwd } = useFocusedScope();
	const listId = useId();
	const anchor = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [options, setOptions] = useState<string[] | null>(null);
	const [active, setActive] = useState(0);
	const { host, repo } = target;
	useEffect(() => {
		if (!open) return;
		let live = true;
		const named = { ...(host ? { host } : {}), ...(repo ? { repo } : {}) };
		const op = field === "labels" ? "label_list" : "assignable";
		readChoices(targetKey(cwd, named, op), async () =>
			field === "labels"
				? (await github({ op: "label_list", ...named })).map(label => label.name)
				: github({ op: "assignable", ...named }),
		).then(
			found => live && setOptions(found),
			error => {
				if (!live) return;
				setOptions([]);
				toastError({ title: t("prCenter.people.loadFailed"), error });
			},
		);
		return () => {
			live = false;
		};
	}, [open, field, cwd, host, repo, t]);
	const shown = (options ?? [])
		.filter(option => !taken.includes(option) && option.toLowerCase().includes(query.trim().toLowerCase()))
		.slice(0, 50);
	const pick = (value: string | undefined) => {
		if (!value) return;
		setOpen(false);
		setQuery("");
		onPick(value);
	};
	return (
		<>
			<IconButton
				icon={<Plus />}
				label={t(`prCenter.people.add.${field}`)}
				onClick={() => setOpen(true)}
				ref={anchor}
				size="sm"
			/>
			<Popover
				anchorRef={anchor}
				ariaLabel={t(`prCenter.people.add.${field}`)}
				onClose={() => setOpen(false)}
				open={open}
			>
				<div className="flex w-64 flex-col gap-2">
					<SearchField
						label={t(`prCenter.people.search.${field}`)}
						listbox={{ id: listId, activeId: shown[active] ? `${listId}-${active}` : undefined }}
						onKeyDown={event => {
							if (isImeKeyEvent(event)) return;
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault();
								const step = event.key === "ArrowDown" ? 1 : -1;
								setActive(index => Math.max(0, Math.min(shown.length - 1, index + step)));
							} else if (event.key === "Enter") {
								event.preventDefault();
								pick(shown[active]);
							}
						}}
						onValueChange={value => {
							setQuery(value);
							setActive(0);
						}}
						placeholder={t(`prCenter.people.search.${field}`)}
						value={query}
					/>
					<div className="flex max-h-64 flex-col overflow-y-auto" id={listId} role="listbox">
						{options === null ? (
							<p className="px-2 py-1 text-sc-sm text-(--sc-text-muted)">{t("prCenter.loading")}</p>
						) : shown.length === 0 ? (
							<p className="px-2 py-1 text-sc-sm text-(--sc-text-muted)">{t("prCenter.people.none")}</p>
						) : (
							shown.map((option, index) => (
								<OptionRow
									active={index === active}
									id={`${listId}-${index}`}
									key={option}
									onClick={() => pick(option)}
									size="xs"
								>
									<span className="truncate text-sc-sm">{field === "labels" ? option : `@${option}`}</span>
								</OptionRow>
							))
						)}
					</div>
				</div>
			</Popover>
		</>
	);
}

export interface PeopleFieldsProps {
	kind: "pr" | "issue";
	number: number;
	target?: GithubTarget;
	reviewers?: readonly string[];
	assignees: readonly string[];
	labels: readonly string[];
	/** False shows the rows read-only (a closed item, a phone that only reads). */
	editable: boolean;
	/** After a change landed (or failed: GitHub may have kept part of it). */
	onChanged: () => void;
}

export function PeopleFields({
	kind,
	number,
	target = {},
	reviewers,
	assignees,
	labels,
	editable,
	onChanged,
}: PeopleFieldsProps) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const fields: Array<[Field, readonly string[]]> = [
		...(kind === "pr" ? [["reviewers", reviewers ?? []] as [Field, readonly string[]]] : []),
		["assignees", assignees],
		["labels", labels],
	];
	const change = async (field: Field, value: string, add: boolean) => {
		const people: GithubPeople = { [field]: [value] };
		setBusy(true);
		try {
			await github({ op: "people", kind, number, add: add ? people : {}, remove: add ? {} : people, ...target });
		} catch (error) {
			toastError({ title: t("prCenter.people.failed"), error });
		} finally {
			setBusy(false);
			onChanged();
		}
	};
	return (
		<dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5 text-sc-sm" data-pr-people>
			{fields.map(([field, values]) => (
				<div className="contents" key={field}>
					<dt className="text-(--sc-text-muted)">{t(`prCenter.people.${field}`)}</dt>
					<dd className="flex min-w-0 flex-wrap items-center gap-1.5">
						{values.length === 0 && !editable && <span className="text-(--sc-text-subtle)">—</span>}
						{values.map(value =>
							editable ? (
								<Chip
									disabled={busy}
									key={value}
									onRemove={() => void change(field, value, false)}
									removeLabel={t("prCenter.people.remove", { name: value })}
								>
									{field === "labels" ? value : `@${value}`}
								</Chip>
							) : (
								<Chip key={value}>{field === "labels" ? value : `@${value}`}</Chip>
							),
						)}
						{editable && (
							<ChoicePicker
								field={field}
								onPick={value => void change(field, value, true)}
								taken={values}
								target={target}
							/>
						)}
					</dd>
				</div>
			))}
		</dl>
	);
}
