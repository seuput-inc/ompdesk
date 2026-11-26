/** Starting points for a new schedule (the empty state and the New menu): a name, a prompt and when it runs. */
import type { ScheduleFrequency } from "../../../../shared/schedules";

export interface ScheduleTemplate {
	id: "review" | "prs" | "cleanup";
	frequency: ScheduleFrequency;
}

/** Names and prompts are `schedules.template.<id>.name` / `.prompt` in the UI language. */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
	{ id: "review", frequency: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] } },
	{ id: "prs", frequency: { kind: "interval", minutes: 30 } },
	{ id: "cleanup", frequency: { kind: "daily", time: "17:00", days: [] } },
];
