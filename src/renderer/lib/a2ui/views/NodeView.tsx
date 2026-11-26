/**
 * One A2UI node drawn by the catalog's view of its type (docs/design/a2ui.md §2). A type the catalog does not draw is
 * one muted line naming it, never an element by that name (§4 rule 1); a child that has not arrived yet (a streaming
 * surface draws from its root) is a skeleton line in its place.
 */

import type { ComponentNode } from "@a2ui/web_core";
import type { ComponentType } from "react";
import { Skeleton } from "../../../components/common";
import { useT } from "../../i18n";
import { useSignal } from "../use-signal";
import { ChartView } from "./Chart";
import { IconView, ImageView, TextView } from "./content";
import { ButtonView, CheckBoxView, ChoicePickerView, DateTimeInputView, SliderView, TextFieldView } from "./inputs";
import { CardView, ColumnView, DividerView, ListView, ModalView, RowView, TabsView } from "./layout";
import type { ViewProps } from "./props";

type View = ComponentType<ViewProps & { inline?: boolean }>;

/** Every component of a2ui-catalog.json; `catalog.test.ts` pins that the two name the same set. */
export const A2UI_VIEWS: Record<string, View> = {
	Text: TextView,
	Image: ImageView,
	Icon: IconView,
	Row: RowView,
	Column: ColumnView,
	List: ListView,
	Card: CardView,
	Tabs: TabsView,
	Modal: ModalView,
	Divider: DividerView,
	Button: ButtonView,
	TextField: TextFieldView,
	CheckBox: CheckBoxView,
	ChoicePicker: ChoicePickerView,
	Slider: SliderView,
	DateTimeInput: DateTimeInputView,
	Chart: ChartView,
};

/** `inline`: inside a button or a dialog trigger, where a Text is the label's words and a Button its label. */
export function NodeView({ node, inline }: { node: ComponentNode; inline?: boolean }) {
	const t = useT();
	const props = useSignal(node.props);
	if (node.state === "pending") return <Skeleton className="h-5 w-full" />;
	if (node.state === "cyclic") return null;
	const View = node.state === "resolved" && Object.hasOwn(A2UI_VIEWS, node.type) ? A2UI_VIEWS[node.type] : undefined;
	if (!View) {
		return (
			<p className="text-sc-sm text-(--sc-text-muted)" data-a2ui-unsupported>
				{t("a2ui.unsupported", { type: node.type })}
			</p>
		);
	}
	const weight = typeof props.weight === "number" && props.weight > 0 ? props.weight : undefined;
	const view = <View inline={inline} node={node} props={props} />;
	return weight ? <div style={{ flex: `${weight} 1 0`, minWidth: 0 }}>{view}</div> : view;
}
