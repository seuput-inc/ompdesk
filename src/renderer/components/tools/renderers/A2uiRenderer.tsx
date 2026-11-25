/**
 * The `a2ui` tool call's card (docs/design/a2ui.md §2 › Where it draws). The surfaces are the session's fold of its
 * `a2ui` calls (`lib/a2ui/session.ts`); a call's card draws each surface it touched while it is the newest call that
 * touched it, and one line "Updated below" otherwise.
 *
 * The call's own chat row under the work card (`A2uiCard live`, cut out by `buildHistoryRows`) is the one that may
 * answer, and only while the call's marker form is pending here (§2 › Actions back to the agent): a Button's action
 * then answers that form request with the action, through the same responder the ask card uses, so the first answer
 * wins across windows, paired computers and the phone. The step's folded body in the work card (the REGISTRY's
 * `A2uiChatCard`, also the live card while the arguments stream) draws the same surfaces inert, never a second
 * answerable copy.
 */

import type { ActionPayload } from "@a2ui/web_core";
import { AppWindow, Check } from "lucide-react";
import { useEffect, useRef } from "react";
import {
	A2UI_ANSWER_FIELD,
	A2UI_ANSWER_MAX_CHARS,
	type A2uiAction,
	a2uiMarkerToolCallId,
} from "../../../../../resources/gui-bridge/modes/a2ui-contracts";
import { useExtensionUiResponder } from "../../../hooks/use-extension-ui";
import type { A2uiSession } from "../../../lib/a2ui/session";
import { useA2uiSession } from "../../../lib/a2ui/use-session";
import { SurfaceView } from "../../../lib/a2ui/views/SurfaceView";
import { resultDetails } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { toast } from "../../../stores/toast";
import { callIdOfEntryKey, selectToolEntry, useToolsStore } from "../../../stores/tools";
import { requestRevealStep } from "../../chat/work/reveal-step";
import { Button } from "../../common";
import { PromptCard, TimeoutFooter } from "../../dialogs/PromptCard";

/** The action as the bridge takes it back: the surface's whole data model rides along only when it asked. */
function answerOf(session: A2uiSession, action: ActionPayload): A2uiAction {
	const surface = session.surface(action.surfaceId);
	const answer: A2uiAction = {
		name: action.name,
		surfaceId: action.surfaceId,
		sourceComponentId: action.sourceComponentId,
		timestamp: action.timestamp,
		context: action.context ?? {},
	};
	if (action.userMessage) answer.userMessage = action.userMessage;
	if (surface?.sendDataModel) answer.dataModel = surface.dataModel.get("/") as Record<string, unknown>;
	return answer;
}

/** The pending marker form of call `callId` in this tab, if the agent waits on it. */
function usePendingForm(callId: string): string | undefined {
	return useExtensionUiStore(
		state =>
			state.pendingRequests.find(
				request => request.method === "form" && a2uiMarkerToolCallId(request.html) === callId,
			)?.id,
	);
}

export function A2uiCard({ toolCallId, live = false }: { toolCallId: string; live?: boolean }) {
	const t = useT();
	const session = useA2uiSession();
	const call = session.call(toolCallId);
	const callId = callIdOfEntryKey(toolCallId);
	const pending = usePendingForm(callId);
	const entry = useToolsStore(state => selectToolEntry(state, toolCallId));
	// A call that has its result waits for nobody, whatever request this view still holds.
	const answering = live && pending !== undefined && (entry?.status === "pending" || entry?.status === "running");
	const respond = useExtensionUiResponder();
	const removeRequest = useExtensionUiStore(state => state.removeRequest);
	const details = resultDetails(entry?.result);
	const sending = useRef<string | null>(null);

	const answer = async (data: { [A2UI_ANSWER_FIELD]: string } | null): Promise<void> => {
		if (!pending || sending.current === pending) return;
		sending.current = pending;
		const delivered = await respond(
			data === null
				? { type: "extension_ui_response", id: pending, cancelled: true }
				: { type: "extension_ui_response", id: pending, data },
		);
		if (delivered) removeRequest(pending);
		else sending.current = null;
	};
	const answerRef = useRef(answer);
	answerRef.current = answer;

	// Every surface of the session fires into it; this card answers for the surfaces it draws.
	useEffect(() => {
		if (!answering) return;
		return session.onAction(action => {
			if (session.owner(action.surfaceId) !== toolCallId) return;
			const text = JSON.stringify(answerOf(session, action));
			if (text.length > A2UI_ANSWER_MAX_CHARS) {
				toast({ variant: "error", message: t("a2ui.tooLarge") });
				return;
			}
			void answerRef.current({ [A2UI_ANSWER_FIELD]: text });
		});
	}, [answering, session, toolCallId, t]);

	if (!call) return null;
	const sent = details?.action && typeof details.action === "object" ? (details.action as Partial<A2uiAction>) : null;
	const surfaces = [...call.surfaces].flatMap(id => {
		const surface = session.surface(id);
		return surface ? [{ id, surface, drawn: session.owner(id) === toolCallId }] : [];
	});
	return (
		<div
			className="flex min-w-0 flex-col gap-3"
			data-a2ui-call={callId}
			data-a2ui-card={toolCallId}
			data-a2ui-live={answering ? "" : undefined}
		>
			{surfaces.map(({ id, surface, drawn }) =>
				drawn ? (
					<SurfaceView
						inert={!answering}
						key={id}
						pressedId={sent?.surfaceId === id ? sent.sourceComponentId : undefined}
						surface={surface}
					/>
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
			{answering ? (
				<Button className="self-start" data-a2ui-skip onClick={() => void answer(null)} size="sm" variant="ghost">
					{t("a2ui.skip")}
				</Button>
			) : null}
			{sent?.name ? (
				<p className="flex items-center gap-1.5 text-sc-sm text-(--sc-text-muted)" data-a2ui-sent>
					<Check aria-hidden className="size-(--sc-icon-sm) text-(--sc-success)" />
					{t("a2ui.sent", { action: sent.name })}
				</p>
			) : details?.dismissed === true ? (
				<p className="text-sc-sm text-(--sc-text-muted)" data-a2ui-dismissed>
					{t("a2ui.dismissed")}
				</p>
			) : null}
		</div>
	);
}

/**
 * The dock's one row for an `a2ui` form (ExtensionDialog's `form` case): where to answer, and Skip. It lives in this
 * chunk, which the call's card in the chat has loaded by the time stock raises the form.
 */
export function A2uiWaiting({
	callId,
	onSkip,
	remaining,
}: {
	callId: string;
	onSkip: () => void;
	remaining: number | null;
}) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const entryKey = useToolsStore(state => state.entryKeyForCallId(callId));
	return (
		<PromptCard
			footer={
				<div className="flex w-full items-center justify-between gap-3" data-a2ui-waiting={callId}>
					<Button
						data-a2ui-jump
						onClick={() => tabId && requestRevealStep({ tabId, key: entryKey })}
						size="sm"
						variant="secondary"
					>
						{t("a2ui.jump")}
					</Button>
					<Button data-a2ui-dock-skip onClick={onSkip} size="sm" variant="ghost">
						{t("a2ui.skip")}
					</Button>
				</div>
			}
			icon={AppWindow}
			label={t("a2ui.waiting")}
			onCancel={onSkip}
		>
			<TimeoutFooter remaining={remaining} />
		</PromptCard>
	);
}
