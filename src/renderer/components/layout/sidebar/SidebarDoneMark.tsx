import { Check } from "lucide-react";
import { useState } from "react";
import { cx } from "../../../lib/format";

/**
 * The ✓ of an unseen finish at a session row's end, in the unread color (Orca's `--unread`: a result to read, not a
 * state). It pops once (`.omp-done-pop`) when `fresh`: the finish happened while the row was on screen. A row that
 * arrives already finished (first paint, a list reload) shows it still, and a re-render never plays it again: the
 * choice is made when the mark mounts.
 */
export function SidebarDoneMark({ fresh }: { fresh: boolean }) {
	const [pop] = useState(fresh);
	return (
		<Check
			aria-hidden
			className={cx("size-(--sc-icon-sm) text-(--sc-unread)", pop && "omp-done-pop")}
			data-sidebar-done
		/>
	);
}
