import type { SchedulesState } from "../../shared/schedules";
import { ScheduleService, type ScheduleServiceOptions } from "../schedules";

/** Tests inspect exactly the snapshots sent to a window; production keeps no second copy. */
export class ObservedSchedules extends ScheduleService {
	latest!: SchedulesState;

	constructor(options: ScheduleServiceOptions) {
		super({
			...options,
			onState: state => {
				this.latest = state;
				options.onState(state);
			},
		});
	}
}
