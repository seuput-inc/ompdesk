/**
 * The `a2ui` tool call's card (docs/design/a2ui.md §2 › Where it draws). The surfaces are the session's fold of its
 * `a2ui` calls (`lib/a2ui/session.ts`); a call's card draws each surface it touched while it is the newest call that
 * touched it, and one line "Updated below" otherwise.
 *
 * The call's own chat row under the work card (`A2uiCard`, cut out by `buildHistoryRows`) is the one that may answer;
 * the step's folded body in the work card (`A2uiRenderer`, also the live card while the arguments stream) draws the
 * same surfaces inert, never a second answerable copy.
 */

import { useA2uiSession } from "../../../lib/a2ui/use-session";
import { SurfaceView } from "../../../lib/a2ui/views/SurfaceView";
import { useT } from "../../../lib/i18n";
import type { ToolRendererProps } from "../ToolCard";

export function A2uiCard({ toolCallId, live = false }: { toolCallId: string; live?: boolean }) {
	const t = useT();
	const session = useA2uiSession();
	const call = session.call(toolCallId);
	if (!call) return null;
	const surfaces = [...call.surfaces].flatMap(id => {
		const surface = session.surface(id);
		return surface ? [{ id, surface, drawn: session.owner(id) === toolCallId }] : [];
	});
	return (
		<div className="flex min-w-0 flex-col gap-3" data-a2ui-card={toolCallId}>
			{surfaces.map(({ id, surface, drawn }) =>
				drawn ? (
					<SurfaceView inert={!live} key={id} surface={surface} />
				) : (
					<p className="text-sc-sm text-(--sc-text-muted)" data-a2ui-moved={id} key={id}>
						{t("a2ui.updatedBelow")}
					</p>
				),
			)}
			{surfaces.length === 0 && call.errors.length > 0 ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-a2ui-not-shown>
					{t("a2ui.notShown")}
				</p>
			) : null}
		</div>
	);
}

export function A2uiRenderer({ toolCallId }: ToolRendererProps) {
	return toolCallId ? <A2uiCard toolCallId={toolCallId} /> : null;
}
