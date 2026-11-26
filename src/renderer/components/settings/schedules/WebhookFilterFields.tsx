/**
 * A webhook routine's "Only when" filters in the schedule dialog: tests on the call (a path under `body.` or
 * `headers.`, an op, values), text the body must contain, and the fields quoted to the run (`pick`). The shapes and
 * limits are the shared `WEBHOOK_FILTER_LIMITS`; the dialog's `scheduleDraftProblem` says when a row is malformed.
 */
import { Plus, X } from "lucide-react";
import { WEBHOOK_FILTER_LIMITS, WEBHOOK_WHERE_OPS, type WebhookWhereOp } from "../../../../shared/schedules";
import { useT } from "../../../lib/i18n";
import { Button, FieldLabel, IconButton, Input, Select } from "../../common";

/** One "Only when" row as typed: `values` is a comma list. */
export interface WhereRow {
	path: string;
	op: WebhookWhereOp;
	values: string;
}

export interface WebhookFilters {
	where: WhereRow[];
	contains: string;
	/** Comma list of paths. */
	pick: string;
}

const OP_KEY: Record<WebhookWhereOp, string> = {
	"=": "schedules.where.op.eq",
	"!=": "schedules.where.op.ne",
	contains: "schedules.where.op.contains",
	exists: "schedules.where.op.exists",
	"!exists": "schedules.where.op.missing",
};

/** Whether an op tests values (`=`, `!=`, `contains`) or only presence. */
export function opTakesValues(op: WebhookWhereOp): boolean {
	return op !== "exists" && op !== "!exists";
}

export function WebhookFilterFields({
	filters,
	onChange,
	error,
	idPrefix,
}: {
	filters: WebhookFilters;
	onChange: (next: WebhookFilters) => void;
	error?: string;
	idPrefix: string;
}) {
	const t = useT();
	const setRow = (index: number, row: Partial<WhereRow>) =>
		onChange({
			...filters,
			where: filters.where.map((item, at) => (at === index ? { ...item, ...row } : item)),
		});
	return (
		<div className="flex flex-col gap-3" data-schedule-webhook-filters>
			<div aria-labelledby={`${idPrefix}-where-label`} className="flex flex-col gap-1.5" role="group">
				<FieldLabel as="span" id={`${idPrefix}-where-label`}>
					{t("schedules.where.title")}
				</FieldLabel>
				<p className="text-sc-xs text-(--sc-text-muted)">{t("schedules.where.hint")}</p>
				{filters.where.map((row, index) => (
					<div className="flex flex-wrap items-center gap-1.5" data-schedule-where={index} key={index}>
						<Input
							aria-label={t("schedules.where.path")}
							className="min-w-32 flex-1"
							controlSize="sm"
							maxLength={WEBHOOK_FILTER_LIMITS.path}
							mono
							onChange={event => setRow(index, { path: event.target.value })}
							placeholder="body.action"
							value={row.path}
						/>
						<Select
							aria-label={t("schedules.where.op")}
							controlSize="sm"
							onChange={event => setRow(index, { op: event.target.value as WebhookWhereOp })}
							options={WEBHOOK_WHERE_OPS.map(op => ({ value: op, label: t(OP_KEY[op]) }))}
							value={row.op}
						/>
						{opTakesValues(row.op) && (
							<Input
								aria-label={t("schedules.where.values")}
								className="min-w-32 flex-1"
								controlSize="sm"
								onChange={event => setRow(index, { values: event.target.value })}
								placeholder={t("schedules.where.valuesPlaceholder")}
								value={row.values}
							/>
						)}
						<IconButton
							icon={<X />}
							label={t("schedules.where.remove")}
							onClick={() => onChange({ ...filters, where: filters.where.filter((_, at) => at !== index) })}
							size="sm"
						/>
					</div>
				))}
				<div>
					<Button
						disabled={filters.where.length >= WEBHOOK_FILTER_LIMITS.where}
						icon={<Plus />}
						onClick={() =>
							onChange({ ...filters, where: [...filters.where, { path: "body.", op: "=", values: "" }] })
						}
						size="sm"
						variant="ghost"
					>
						{t("schedules.where.add")}
					</Button>
				</div>
				{error && (
					<span className="text-sc-sm text-(--sc-danger)" role="alert">
						{error}
					</span>
				)}
			</div>
			<Input
				label={t("schedules.where.contains")}
				maxLength={WEBHOOK_FILTER_LIMITS.value}
				onChange={event => onChange({ ...filters, contains: event.target.value })}
				value={filters.contains}
			/>
			<Input
				hint={t("schedules.where.pickHint")}
				label={t("schedules.where.pick")}
				mono
				onChange={event => onChange({ ...filters, pick: event.target.value })}
				placeholder="body.action, headers.x-github-event"
				value={filters.pick}
			/>
		</div>
	);
}
