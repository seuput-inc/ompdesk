/**
 * The PR list's filters past its state and view (Orca `github/PRFilterDropdowns.tsx`, `PRFilterPickers.tsx`,
 * `PRFilterSections.tsx`): author, label, assignee (a login or `@me`) and drafts only, applied together from a
 * popover; the button says how many are on.
 */
import { ListFilter } from "lucide-react";
import { useId, useRef, useState } from "react";
import type { RpcPrListFilter } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { usePrCenterStore } from "../../../stores/pr-center";
import { Button, Checkbox, Input, Popover } from "../../common";

const FIELDS = ["author", "label", "assignee"] as const;

export function PrListFilter() {
	const t = useT();
	const draftId = useId();
	const anchor = useRef<HTMLButtonElement>(null);
	const filter = usePrCenterStore(state => state.listFilter);
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<RpcPrListFilter>(filter);
	const count = [filter.author, filter.label, filter.assignee, filter.draft].filter(Boolean).length;
	const apply = (next: RpcPrListFilter) => {
		setOpen(false);
		usePrCenterStore.getState().setListFilter(next);
	};
	return (
		<>
			<Button
				aria-haspopup="dialog"
				icon={<ListFilter />}
				onClick={() => {
					setDraft(filter);
					setOpen(true);
				}}
				ref={anchor}
				size="sm"
				variant={count > 0 ? "secondary" : "ghost"}
			>
				{count > 0 ? t("prCenter.filter.count", { count: String(count) }) : t("prCenter.filter.open")}
			</Button>
			<Popover anchorRef={anchor} ariaLabel={t("prCenter.filter.open")} onClose={() => setOpen(false)} open={open}>
				<form
					className="flex w-64 flex-col gap-3"
					onSubmit={event => {
						event.preventDefault();
						apply({
							author: draft.author?.trim() || undefined,
							label: draft.label?.trim() || undefined,
							assignee: draft.assignee?.trim() || undefined,
							draft: draft.draft || undefined,
						});
					}}
				>
					{FIELDS.map(field => (
						<Input
							controlSize="sm"
							key={field}
							label={t(`prCenter.filter.${field}`)}
							onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))}
							placeholder={t(`prCenter.filter.${field}Placeholder`)}
							value={draft[field] ?? ""}
						/>
					))}
					<label className="flex items-center gap-2 text-sc-sm text-(--sc-text-secondary)" htmlFor={draftId}>
						<Checkbox
							checked={Boolean(draft.draft)}
							id={draftId}
							onChange={event => setDraft(current => ({ ...current, draft: event.target.checked }))}
						/>
						{t("prCenter.filter.draft")}
					</label>
					<div className="flex justify-end gap-2">
						<Button onClick={() => apply({})} size="sm" variant="ghost">
							{t("prCenter.filter.clear")}
						</Button>
						<Button size="sm" type="submit" variant="primary">
							{t("prCenter.filter.apply")}
						</Button>
					</div>
				</form>
			</Popover>
		</>
	);
}
