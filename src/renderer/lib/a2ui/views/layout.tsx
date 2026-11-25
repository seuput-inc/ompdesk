/** A2UI's containers on the kit: Row, Column, List, Card, Tabs, Modal, Divider (docs/design/a2ui.md §2 table). */

import { useState } from "react";
import { Button, Card, Modal, Tabs } from "../../../components/common";
import { cx } from "../../format";
import { useT } from "../../i18n";
import { NodeView } from "./NodeView";
import { isNode, readText, type ViewProps } from "./props";

/** A List draws at most this many children (§4 Bounded; the bridge refuses more). */
const LIST_MAX = 200;

const JUSTIFY: Record<string, string> = {
	start: "justify-start",
	center: "justify-center",
	end: "justify-end",
	spaceBetween: "justify-between",
	spaceAround: "justify-around",
	spaceEvenly: "justify-evenly",
	stretch: "justify-stretch",
};
const ALIGN: Record<string, string> = {
	start: "items-start",
	center: "items-center",
	end: "items-end",
	stretch: "items-stretch",
};

function children(props: Record<string, unknown>) {
	return Array.isArray(props.children) ? props.children.filter(isNode) : [];
}

function flexClasses(props: Record<string, unknown>, row: boolean): string {
	return cx(
		"flex min-w-0 gap-3",
		row ? "flex-row flex-wrap" : "flex-col",
		JUSTIFY[String(props.justify)],
		ALIGN[String(props.align)] ?? (row ? "items-center" : "items-stretch"),
	);
}

export function RowView({ props }: ViewProps) {
	return (
		<div className={flexClasses(props, true)}>
			{children(props).map(child => (
				<NodeView key={child.instanceId} node={child} />
			))}
		</div>
	);
}

export function ColumnView({ props }: ViewProps) {
	return (
		<div className={flexClasses(props, false)}>
			{children(props).map(child => (
				<NodeView key={child.instanceId} node={child} />
			))}
		</div>
	);
}

export function ListView({ props }: ViewProps) {
	const row = props.direction === "horizontal";
	return (
		<div className={flexClasses(props, row)} role="list">
			{children(props)
				.slice(0, LIST_MAX)
				.map(child => (
					<div className="min-w-0" key={child.instanceId} role="listitem">
						<NodeView node={child} />
					</div>
				))}
		</div>
	);
}

export function CardView({ props }: ViewProps) {
	return <Card padding="md">{isNode(props.child) ? <NodeView node={props.child} /> : null}</Card>;
}

export function DividerView({ props }: ViewProps) {
	return props.axis === "vertical" ? (
		<div aria-hidden className="w-px self-stretch bg-(--sc-border-subtle)" />
	) : (
		<hr className="w-full border-0 border-t border-(--sc-border-subtle)" />
	);
}

export function TabsView({ props }: ViewProps) {
	const t = useT();
	const [active, setActive] = useState("0");
	const tabs: Record<string, unknown>[] = Array.isArray(props.tabs) ? props.tabs : [];
	const shown = tabs[Number(active)];
	return (
		<div className="flex min-w-0 flex-col gap-3">
			<Tabs
				activeId={active}
				ariaLabel={t("a2ui.tabs")}
				onChange={setActive}
				tabs={tabs.map((tab, index) => ({ id: String(index), label: readText(tab.title) }))}
				variant="underline"
			/>
			<div aria-label={readText(shown?.title)} className="min-w-0" role="tabpanel">
				{isNode(shown?.child) ? <NodeView key={shown.child.instanceId} node={shown.child} /> : null}
			</div>
		</div>
	);
}

/** The trigger opens the content in a kit dialog; a trigger Button's own action is that opening. */
export function ModalView({ props }: ViewProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button className="self-start" onClick={() => setOpen(true)} variant="secondary">
				{isNode(props.trigger) ? <NodeView inline node={props.trigger} /> : t("a2ui.open")}
			</Button>
			<Modal ariaLabel={t("a2ui.dialog")} onClose={() => setOpen(false)} open={open}>
				{isNode(props.content) ? <NodeView node={props.content} /> : null}
			</Modal>
		</>
	);
}
