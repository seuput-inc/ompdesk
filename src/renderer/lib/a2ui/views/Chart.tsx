/**
 * OMPdesk's `Chart` component (a2ui-catalog.json): a bar, line or doughnut chart on chart.js through `lib/chart.ts`, so
 * it wears the theme's series colours and repaints with the theme. `description` names the picture for a screen reader.
 */

import { type ComponentNode, computed, DataContext, getValue } from "@a2ui/web_core";
import { useContext, useMemo } from "react";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { baseChartOptions, chartColors, useChartThemeKey, withAlpha } from "../../chart";
import { useSignal } from "../use-signal";
import { A2uiViewContext, read, readText, type ViewProps } from "./props";

interface Series {
	label: string;
	values: number[];
}

const numbers = (value: unknown): number[] =>
	Array.isArray(value) ? value.map(v => (typeof v === "number" && Number.isFinite(v) ? v : 0)) : [];

/** Each series' numbers: a literal array, or the data model array its `{"@path"}` names (kept live). */
function useSeries(node: ComponentNode, raw: unknown): Series[] {
	const { surface } = useContext(A2uiViewContext);
	const signal = useMemo(() => {
		const data = surface ? new DataContext(surface, node.dataPath) : undefined;
		return computed(() =>
			(Array.isArray(raw) ? raw : []).map((series: Record<string, unknown>) => ({
				label: readText(series.label),
				values: numbers(
					Array.isArray(series.values) || !data ? series.values : getValue(data.resolveSignal(series.values)),
				),
			})),
		);
	}, [surface, node, raw]);
	return useSignal(signal);
}

export function ChartView({ node, props }: ViewProps) {
	const themeKey = useChartThemeKey();
	const series = useSeries(node, props.series);
	const labelsValue = read(props.labels);
	const labels = Array.isArray(labelsValue) ? labelsValue.map(String) : [];
	const kind = props.kind === "line" || props.kind === "doughnut" ? props.kind : "bar";
	// biome-ignore lint/correctness/useExhaustiveDependencies: themeKey re-reads the theme's tokens.
	const { data, options } = useMemo(() => {
		const colors = chartColors();
		const base = baseChartOptions();
		const datasets = series.map((s, index) => {
			const color = colors[index % colors.length] ?? "";
			return kind === "doughnut"
				? { label: s.label, data: s.values, backgroundColor: s.values.map((_, i) => colors[i % colors.length]) }
				: { label: s.label, data: s.values, backgroundColor: withAlpha(color, 0.75), borderColor: color };
		});
		const legend = { ...base.plugins.legend, display: kind === "doughnut" || series.length > 1 };
		return {
			data: { labels, datasets },
			options:
				kind === "doughnut"
					? { ...base, scales: {}, plugins: { ...base.plugins, legend } }
					: { ...base, plugins: { ...base.plugins, legend } },
		};
	}, [series, labels.join("\n"), kind, themeKey]);
	const description = readText(props.description);
	return (
		<figure className="m-0 min-w-0" data-a2ui-chart={kind}>
			<div aria-label={description} className="relative h-56 w-full" role="img">
				{kind === "line" ? (
					<Line data={data} options={options} />
				) : kind === "doughnut" ? (
					<Doughnut data={data} options={options} />
				) : (
					<Bar data={data} options={options} />
				)}
			</div>
		</figure>
	);
}
