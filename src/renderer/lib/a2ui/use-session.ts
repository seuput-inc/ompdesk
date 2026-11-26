/**
 * The A2UI session of the tab a component renders in: one `A2uiSession` per tab runtime, synced with that tab's
 * transcript (committed and live messages) and the `a2ui` calls whose arguments still stream (docs/design/a2ui.md §2).
 */

import { useContext, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useMessagesStore } from "../../stores/messages";
import { SessionRuntimeContext } from "../../stores/session-runtime-context";
import { callIdOfEntryKey, useToolsStore } from "../../stores/tools";
import { uiLocale } from "../format";
import { A2uiSession, a2uiCalls } from "./session";

const sessions = new WeakMap<object, A2uiSession>();
/** Tests and the start-up race render outside a tab runtime: they share one session. */
const NO_RUNTIME = {};

export function useA2uiSession(): A2uiSession {
	const owner = useContext(SessionRuntimeContext) ?? NO_RUNTIME;
	const known = sessions.get(owner);
	const session = known ?? new A2uiSession(uiLocale());
	if (!known) sessions.set(owner, session);
	const messages = useMessagesStore(s => s.messages);
	const liveMessages = useMessagesStore(s => s.liveMessages);
	const liveTools = useToolsStore(s => s.liveTools);
	const calls = useMemo(() => {
		const streaming = [...liveTools].flatMap(([key, entry]) =>
			entry.toolName === "a2ui" && entry.status === "pending"
				? [{ id: callIdOfEntryKey(key), key, args: entry.args }]
				: [],
		);
		return a2uiCalls([...messages, ...liveMessages], streaming);
	}, [messages, liveMessages, liveTools]);
	// Every card of the tab syncs the same calls; only the first of a change applies anything.
	useLayoutEffect(() => session.sync(calls), [session, calls]);
	useSyncExternalStore(session.subscribe, () => session.version);
	return session;
}
