/**
 * OMPdesk's `Chart` component (a2ui-catalog.json): a bar, line or doughnut chart on chart.js through `lib/chart.ts`, so
 * it wears the theme's series colours and repaints with the theme. `description` names the picture for a screen reader.
 */

import { useMemo } from "react";
import { Bar, Doughnut, Line } from "react-chartjs-2";
import { baseChartOptions, chartColors, useChartThemeKey, withAlpha } from "../../chart";
import { read, readText, type ViewProps } from "./props";

interface Series {
	label: string;
	values: number[];
}

const numbers = (value: unknown): number[] =>
	Array.isArray(value) ? value.map(v => (typeof v === "number" && Number.isFinite(v) ? v : 0)) : [];

/** Each series' label and numbers; web_core's binder resolves a `{"@path"}` series to the data model's array. */
export function chartSeries(raw: unknown): Series[] {
	return (Array.isArray(raw) ? raw : []).map((series: Record<string, unknown>) => ({
		label: readText(series.label),
		values: numbers(read(series.values)),
	}));
}

export function ChartView({ props }: ViewProps) {
	const themeKey = useChartThemeKey();
	const series = chartSeries(props.series);
	// A re-render with the same numbers (a sibling's change) keeps the chart's data object, so chart.js does not redraw.
	const seriesKey = JSON.stringify(series);
	const labelsValue = read(props.labels);
	const labels = Array.isArray(labelsValue) ? labelsValue.map(String) : [];
	const kind = props.kind === "line" || props.kind === "doughnut" ? props.kind : "bar";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by content (seriesKey, the labels); themeKey re-reads the theme's tokens.
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
	}, [seriesKey, labels.join("\n"), kind, themeKey]);
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
