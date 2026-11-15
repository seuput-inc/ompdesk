/**
 * useComposerSubmit: the composer submit controller extracted from InputArea.
 * Owns shell execution, slash-command routing, and current-instruction submission.
 */

import { useCallback, useEffect, useRef } from "react";
import type { AgentMessage, AvailableCommand } from "../../../../shared/rpc-types";
import { refreshNextPromptAfterBash } from "../../../hooks/use-next-prompt";
import { hydrateTabSession } from "../../../hooks/use-rpc-events";
import { endAutoPlan, runAutoMode } from "../../../lib/auto-mode-client";
import { planComposerSubmit, SUBMIT_CANCELLED, settleComposerResponse } from "../../../lib/composer-submit";
import { expandEmoticons } from "../../../lib/emoji";
import { errorDetail } from "../../../lib/error-detail";
import { rememberHistoryImages } from "../../../lib/history-images";
import { useT } from "../../../lib/i18n";
import { parseComposerMode } from "../../../lib/input-modes";
import { abortActiveTurn, clearSessionContext } from "../../../lib/messages";
import { holdMessage, sendsHeld } from "../../../lib/outbox-delivery";
import { danglingPasteFragment, dropReferencedPastes, expandPasteMarkers } from "../../../lib/paste-blobs";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerImage, type ComposerStore, prependToDraft, useComposerStore } from "../../../stores/composer";
import { useInputHistoryStore } from "../../../stores/input-history";
import { type MessagesStore, useMessagesStore } from "../../../stores/messages";
import { useOutboxStore } from "../../../stores/outbox";
import { type PlanApprovalStore, usePlanApprovalStore } from "../../../stores/plan-approval";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { restoreTabComposer, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { webRuntime } from "../../../web/runtime";
import { useAutoModePrefetch } from "./use-auto-mode-prefetch";

export function useComposerSubmit({
	text,
	images,
	sending,
	status,
	isStreaming,
	commands,
	emojiAutocomplete,
	routeReady,
	setText,
	setImages,
	setMenu,
	setSending,
}: {
	text: string;
	images: ComposerImage[];
	sending: boolean;
	status: string;
	isStreaming: boolean;
	commands: AvailableCommand[];
	emojiAutocomplete: boolean;
	routeReady: boolean;
	setText: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	setMenu: (menu: null) => void;
	setSending: (value: boolean) => void;
}) {
	const t = useT();
	const rpc = useTabRpc();
	const contextTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const runtimeTabId = contextTabId ?? activeTabId;
	// The send's own expansion (below), so a question asked while typing is the one the send asks.
	const expandProse = useCallback(
		(draft: string) => (emojiAutocomplete ? expandEmoticons(expandPasteMarkers(draft)) : expandPasteMarkers(draft)),
		[emojiAutocomplete],
	);
	useAutoModePrefetch({ text, isStreaming, status, tabId: runtimeTabId, rpc, expand: expandProse });
	const heldSend = useRef<{ message: string; overrideText?: string } | null>(null);
	const send = useCallback(
		// `overrideText` sends a freshly computed value (voice dictation submit
		// trigger) instead of the rendered `text` state, which lags a setText.
		(overrideText?: string) => {
			const message = (overrideText ?? text).trim();
			if (!message && images.length === 0) return;
			// The previous send is still being answered (a prompt's round trip, a `!` command's whole run): the Enter is
			// held, not dropped, and goes out once that send settles (the effect below).
			if (sending) {
				heldSend.current = { message, overrideText };
				return;
			}
			// An edit that cut into a paste marker left text that names a paste but is not one: sending it would
			// hand the agent the literal fragment and lose the paste (DI-3).
			const fragment = danglingPasteFragment(message);
			if (fragment) {
				toast({ variant: "warning", message: t("input.paste.dangling", { fragment }) });
				return;
			}
			// ↑ history brings the pictures back with the text (stock keeps text only). History holds the
			// paste-expanded text, as stock's does: the blobs are freed once the send is accepted.
			const historyText = expandPasteMarkers(message);
			rememberHistoryImages(historyText, images);
			if (!routeReady || !runtimeTabId) return;
			// A tab whose omp is still starting takes the message: the tab runtime holds the command until it is ready.
			if (status !== "ready" && status !== "starting") {
				toast({ variant: "warning", message: t("input.agentConnecting") });
				return;
			}
			const originTabId = runtimeTabId;
			const originSession = sessionRuntimeStore<SessionStore>(originTabId, "session");
			const originComposer = sessionRuntimeStore<ComposerStore>(originTabId, "composer") ?? useComposerStore;
			if (originComposer.getState().sending || originComposer.getState().submissionUncertain) return;
			const recovering = originComposer.getState().editingRecovered;

			const originMessages = sessionRuntimeStore<MessagesStore>(originTabId, "messages") ?? useMessagesStore;
			const originSessionId = originSession?.getState().sessionId ?? useSessionStore.getState().sessionId;
			const originCwd = (originSession?.getState() ?? useSessionStore.getState()).cwd;
			const originDevice = useTabsStore.getState().tabs.find(tab => tab.id === originTabId)?.device;
			// A shared tab, or any tab a phone sends to, can be sent to by another device at the same moment:
			// whether a message joins the run or starts one is the host's word, not this window's.
			const originTab = useTabsStore.getState().tabs.find(tab => tab.id === originTabId);
			const hostDecides = webRuntime() !== null || originTab?.shared === true || (originTab?.viewerCount ?? 0) > 0;
			const originStillActive = () =>
				originSession
					? sessionRuntimeStore<ComposerStore>(originTabId, "composer") === originComposer
					: useTabsStore.getState().activeTabId === originTabId &&
						useSessionStore.getState().sessionId === originSessionId;
			const restoreDraft = (draft: string, attachments: ComposerImage[]) =>
				restoreTabComposer(
					originTabId,
					originSessionId,
					draft,
					attachments,
					originSession ? originComposer : undefined,
				);
			const restorePrevious = (previous: { draft: string; images: ComposerImage[] }) => {
				originComposer.setState(current => ({
					draft: previous.draft ? prependToDraft(previous.draft, current.draft) : current.draft,
					images: [...previous.images, ...current.images],
				}));
			};
			const recoveredBlocked = () => {
				const manual = useOutboxStore.getState().items.find(item => item.id === recovering?.id);
				const pending = manual?.send.kind === "manual" && manual.send.recovery.kind === "attempt";
				toast({ variant: "warning", message: t(pending ? "input.deliveryUnknown" : "outbox.notKept") });
			};

			let uncertain = false;
			const showSendError = (title: string, error: unknown) =>
				uncertain
					? toast({
							variant: "error",
							title: t("input.deliveryUnknownTitle"),
							message: t("input.deliveryUnknown"),
							detail: errorDetail(error),
						})
					: toastError({ title, error });
			const markUncertain = () => {
				uncertain = true;
				if (!originStillActive()) return;
				originComposer.getState().setSubmissionUncertain(true);
				if (originSession) void hydrateTabSession(originTabId);
			};

			// Paste markers expand to full blob content on every dispatch path (bash, python, prompt, queue
			// items): the wire only ever sees expanded text (TUI getExpandedText parity, regression #3737).
			// Which path a message takes is read from the draft as the user sees it, markers folded: a pasted
			// block that happens to start with `!`, `$ `, `/` or `->` stays a prompt, and the badge the
			// composer showed is the path it takes. Emoticon expansion runs at submit time over the prose
			// (input-controller.ts:617 — Enter without a trailing space after `:)`), never in a shell command
			// (`expandProse` above).
			const expandedMessage = expandProse(message);

			// ↑ history is a record of what the model received, so it is written only
			// once delivery is confirmed. Recording up front left every failed or
			// blocked send in the list, and a recalled entry replays a prompt that
			// never ran.
			const typedMode = recovering ? null : parseComposerMode(message);
			// The link to the computer is down: a message waits in the outbox, shown above the field, and goes once the
			// link is back (lib/outbox-delivery.ts). A command or shell line needs the computer's answer now.
			if (originTab && sendsHeld(originTab)) {
				if (recovering) {
					const deliveryId = crypto.randomUUID();
					if (!originComposer.getState().freezeRecoveredEdit(deliveryId)) {
						recoveredBlocked();
						return;
					}
					if (
						!useOutboxStore.getState().queueManual(
							recovering.id,
							deliveryId,
							expandedMessage,
							images.map(image => image.content),
						)
					) {
						originComposer.getState().thawRecoveredEdit(recovering.id);
						toast({ variant: "warning", message: t("outbox.notKept") });
						return;
					}
					setText("");
					setImages([]);
					const previous = originComposer.getState().finishRecoveredEdit(recovering.id);
					if (previous) restorePrevious(previous);
					setMenu(null);
					dropReferencedPastes(message);
					return;
				}
				if (typedMode || message.startsWith("/")) {
					toast({ variant: "warning", message: t("outbox.messagesOnly") });
					return;
				}
				holdMessage(originTab, {
					text: expandedMessage,
					images: images.map(image => image.content),
				});
				setText("");
				setImages([]);
				setMenu(null);
				dropReferencedPastes(message);
				return;
			}
			const parsed = typedMode && { ...typedMode, body: expandPasteMarkers(typedMode.body) };
			// `! cmd` → bash, `$ code` → python mode (TUI parity): a running
			// ExecutionBubble stands in until the transcript record lands. Python's
			// language is left to the sidecar — interactive eval is python-only
			// today and the GUI tracks no kernel state to source it from.
			const execution =
				parsed?.body && parsed.mode === "bash"
					? {
							pending: {
								role: "bashExecution",
								command: parsed.body,
								excludeFromContext: parsed.excluded,
								timestamp: Date.now(),
								running: true,
							} satisfies AgentMessage,
							run: () =>
								rpc.bash(parsed.body, parsed.excluded).then(response => {
									// The command's output can change what the user says next.
									if (response.success) refreshNextPromptAfterBash(rpc);
									return response;
								}),
							failedTitle: t("input.bashFailed"),
						}
					: parsed?.body && parsed.mode === "python"
						? {
								pending: {
									role: "pythonExecution",
									code: parsed.body,
									timestamp: Date.now(),
									running: true,
								} satisfies AgentMessage,
								run: () => rpc.eval(parsed.body, undefined, parsed.excluded),
								failedTitle: t("input.evalFailed"),
							}
						: undefined;
			if (execution) {
				const { pending, failedTitle } = execution;
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				setSending(true);
				let accepted = false;
				originMessages?.getState().appendMessage(pending);
				void execution
					.run()
					.then(async response => {
						if (originStillActive()) originMessages?.getState().removeMessage(pending);
						if (!response.success) {
							if (response.code === "rpc_delivery_unknown") markUncertain();
							restoreDraft(message, previousImages);
							showSendError(failedTitle, response);
							return;
						}
						accepted = true;
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await hydrateTabSession(originTabId);
					})
					.catch(error => {
						if (accepted) {
							toastError({ title: t("input.refreshFailed"), error });
							return;
						}
						markUncertain();
						if (originStillActive()) originMessages?.getState().removeMessage(pending);
						restoreDraft(message, previousImages);
						showSendError(failedTitle, error);
					})
					.finally(() => {
						if (originStillActive()) setSending(false);
					});
				return;
			}

			// Routing/guarding/hydration policy lives in lib/composer-submit:
			// slash commands always go through prompt (server parses them even
			// while streaming), session-replacing commands are blocked while
			// busy, and local-only resolutions rehydrate the transcript.
			const payload = images.map(image => image.content);
			// A plain prompt from an idle composer waits for the automatic mode choice (about a second on
			// the real judge) before it leaves. Until then Stop and Esc withdraw it (lib/messages.ts
			// abortActiveTurn): nothing reaches omp, a mode the choice already picked ends, the draft returns.
			const withdraw = new AbortController();
			let left = false;
			const session = originSession ?? useSessionStore;
			const deliveryId = recovering ? crypto.randomUUID() : undefined;
			const submit = planComposerSubmit({
				message: expandedMessage,
				typed: recovering ? "" : message,
				images: payload,
				isStreaming,
				commands,
				rpc: deliveryId
					? {
							compact: rpc.compact,
							prompt: (text, pictures) =>
								rpc.command({ type: "prompt", message: text, images: pictures, deliveryId }),
						}
					: rpc,
				signal: withdraw.signal,
				beforePrompt: async () => {
					if (withdraw.signal.aborted) return null;
					const choice = await runAutoMode({
						message: expandedMessage,
						isStreaming,
						session,
						rpc,
						planPending:
							(
								sessionRuntimeStore<PlanApprovalStore>(originTabId, "planApproval") ?? usePlanApprovalStore
							).getState().pending !== null,
						// Stop and Esc return at once; a decision the host makes after that is ended when it lands.
						signal: withdraw.signal,
						onDeciding: deciding => originComposer.getState().setDecidingMode(deciding),
						onLateDecision: late => {
							if (late.mode === "goal") void abortActiveTurn(rpc, originTabId, "auto-mode");
							void rpc.autoModeEnd(late.mode === "goal" ? "goal" : "plan").catch(() => {});
						},
					});
					if (!withdraw.signal.aborted) left = true;
					else if (choice?.mode === "plan") await endAutoPlan(session, rpc);
					// Stock's `goal create` already started the goal's own turn: stopping it ends the goal too.
					else if (choice?.mode === "goal") await abortActiveTurn(rpc, originTabId, "auto-mode");
					return choice;
				},
			});
			if (submit.kind === "blocked") return;
			if (submit.kind === "handled") {
				useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
				setText("");
				setImages([]);
				setMenu(null);
				dropReferencedPastes(message);
				return;
			}
			// Native /clear: drop context in place via clear_context RPC; the draft
			// is restored when the server refuses (busy).
			if (submit.kind === "clear") {
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				void clearSessionContext(rpc, () => hydrateTabSession(originTabId)).then(cleared => {
					if (cleared) {
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (originStillActive()) dropReferencedPastes(message);
						return;
					}
					restoreDraft(message, previousImages);
				});
				return;
			}
			const previousImages = images;
			if (recovering && (!deliveryId || !originComposer.getState().freezeRecoveredEdit(deliveryId))) {
				recoveredBlocked();
				return;
			}
			const restoreFailedSubmit = (unknown = false) => {
				if (!recovering) {
					restoreDraft(message, previousImages);
					return;
				}
				if (!originStillActive()) {
					if (!unknown) useOutboxStore.getState().updateManual(recovering.id, { recovery: { kind: "draft" } });
					return;
				}
				originComposer.setState(current => ({
					draft: message ? prependToDraft(message, current.draft) : current.draft,
					images: [...previousImages, ...current.images],
				}));
				originComposer.getState().thawRecoveredEdit(recovering.id, unknown);
			};
			const optimisticMessage: AgentMessage | undefined =
				!isStreaming && (recovering !== null || !message.startsWith("/"))
					? {
							role: "user",
							content: [{ type: "text", text: expandedMessage }, ...payload],
							timestamp: Date.now(),
							optimistic: true,
							optimisticAfterEntryId:
								originMessages.getState().messages.findLast(entry => entry.entryId)?.entryId ?? null,
						}
					: undefined;
			if (optimisticMessage) originMessages.getState().appendLiveMessage(optimisticMessage);
			else if (hostDecides && (recovering !== null || !message.startsWith("/")))
				originMessages.getState().noteOwnSend(expandedMessage);
			// On a tab other devices send to, the host's own word that the prompt arrived (its echo claimed by the
			// delivery, or dropped on a failure) frees the composer too, so a slow reply to this window's request
			// never keeps it from steering. The request's own settling stays the fallback.
			let stopWatching: (() => void) | undefined;
			if (optimisticMessage && hostDecides) {
				stopWatching = originMessages.subscribe(state => {
					if (state.liveMessages.includes(optimisticMessage)) return;
					stopWatching?.();
					if (originStillActive()) setSending(false);
				});
			}
			// Sending owns the live edge: pull the transcript back to the bottom even
			// when the user had scrolled up through history before pressing Enter.
			(originSession ?? useSessionStore).getState().pinTranscriptToBottom();
			setText("");
			setImages([]);
			setMenu(null);
			setSending(true);
			const cancelSubmit = optimisticMessage
				? () => {
						if (left || withdraw.signal.aborted) return false;
						withdraw.abort();
						return true;
					}
				: null;
			if (cancelSubmit) originComposer.getState().setCancelSubmit(cancelSubmit);
			let accepted = false;
			// Let React commit the cleared draft before contextBridge serializes the
			// request payload. On large sessions/attachments that synchronous bridge
			// work used to make Enter look ignored for a noticeable beat.
			setTimeout(() => {
				if (!originStillActive()) {
					stopWatching?.();
					if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
					restoreFailedSubmit();
					return;
				}
				void submit
					.request()
					.then(async response => {
						if (!response.success) {
							if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
							restoreFailedSubmit(response.code === "rpc_delivery_unknown");
							if (response.code === SUBMIT_CANCELLED) return;
							if (response.code === "rpc_delivery_unknown") markUncertain();
							showSendError(t("input.sendFailed"), response);
							return;
						}
						accepted = true;
						if (recovering) {
							if (originStillActive()) {
								const previous = originComposer.getState().finishRecoveredEdit(recovering.id);
								if (previous) {
									restorePrevious(previous);
									useOutboxStore.getState().drop(recovering.id);
								}
							} else if (recovering.previous.draft || recovering.previous.images.length > 0) {
								useOutboxStore.getState().updateManual(recovering.id, {
									text: expandPasteMarkers(recovering.previous.draft),
									images: recovering.previous.images.map(image => image.content),
									previous: { draft: "", images: [] },
									editing: false,
									recovery: { kind: "previous" },
								});
							} else {
								useOutboxStore.getState().drop(recovering.id);
							}
						}
						useInputHistoryStore.getState().record(historyText, originCwd, rpc, originDevice);
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await settleComposerResponse(response, () => hydrateTabSession(originTabId));
					})
					.catch(error => {
						if (accepted) {
							toastError({ title: t("input.refreshFailed"), error });
							return;
						}
						markUncertain();
						if (optimisticMessage) originMessages.getState().removeLiveMessage(optimisticMessage);
						restoreFailedSubmit(true);
						showSendError(t("input.sendFailed"), error);
					})
					.finally(() => {
						stopWatching?.();
						if (cancelSubmit && originComposer.getState().cancelSubmit === cancelSubmit)
							originComposer.getState().setCancelSubmit(null);
						if (originStillActive()) setSending(false);
					});
			}, 0);
		},
		[
			text,
			images,
			sending,
			status,
			isStreaming,
			commands,
			expandProse,
			routeReady,
			rpc,
			runtimeTabId,
			t,
			setText,
			setImages,
			setSending,
			setMenu,
		],
	);

	// A held Enter goes out when the send it waited for has settled, if the field still holds what was sent: a
	// failed send puts its own text back and an edit changes the draft, and either means the user must press again.
	const latestSend = useRef(send);
	latestSend.current = send;
	useEffect(() => {
		const held = heldSend.current;
		if (sending || !held) return;
		heldSend.current = null;
		if (held.overrideText === undefined && text.trim() !== held.message) return;
		latestSend.current(held.overrideText);
	}, [sending, text]);

	return send;
}
