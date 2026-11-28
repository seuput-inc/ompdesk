# Bot runtime identity

A bot identity answers one question: did this call come from the live omp run that this host started as this bot's chat? It grants no permission and says nothing about who prompted the run. Existing tools, approval cards, and delivery rules do not require this identity.

## Issue only at launch

The Bots page names a local bot and asks for a new chat or a saved chat. The execution host resolves the exact bot ID in its own registry. The host chooses the folder and launch destination. A fresh chat and a chat the host previously started for this bot are eligible. The host records the latter's stock session ID and path so it can find it again. This record is a destination, not an identity. A path overwritten with a different session is not the recorded chat.

Only the separate bot launch can issue an identity. It can use a matching live bot run or start a new one. If an ordinary tab already holds the selected file, the host reports the conflict. It does not promote the holder, close it, or start another writer. An ordinary open or layout restore never issues an identity, even if it opens the exact saved chat. A child session, a handed worker, and an outside CLI caller do not inherit one.

For a saved chat, a known local holder blocks a second open. An external lease probe that cannot answer also blocks it. The probe does not transfer the lease to the child: stock still owns writer exclusion while opening the file. The host checks the session ID and path of the child that actually started; a successful probe cannot establish identity.

The host binds the bot ID to one core instance, one lane instance, and one successful child spawn. The binding stays in host memory. Nothing in a prompt, tool argument, child frame body, environment, session journal, tab layout, or paired snapshot can grant it. At a host tool call, the host identifies the run by the channel that delivered the call. An operation that eventually relies on that identity must recheck the same run and bot immediately before the effect. It must not look up the latest occupant of the caller's tab instead.

Exit, sleep, restart, a core replacement, a session replacement or fork, and deletion of the named bot invalidate the binding. An ordinary automatic restart has none. If the host starts the chat again through the dedicated entrance, it issues a new binding. A late call from the old run cannot act as the new one.

## Keep existing chats working

`BotRecord::observe` has historically listed chats by folder and set the first one as `home`. That is enough to deliver ordinary work, but not to identify an execution. Do not backfill trusted records from this list. The person can still open an old chat and read its transcript. They can start a new host-issued chat from Bots without closing the old one or redirecting its outstanding work.

On its own host, the Bots page prefers `chatHome`, the first chat recorded through the dedicated launch. It is a local display and reopen destination, not proof of a live run. `home` remains the destination for existing delivery.

| Route | Delivery | Identity |
| --- | --- | --- |
| Agent opens a session in a bot's folder | Ordinary tab | None |
| Existing or restored tab, including a saved bot chat | Ordinary messages, reports, schedules, and wakes keep their existing routes | None unless the **same running child** was issued one |
| Person opens a recorded host-created chat through Bots | Execution host can reopen it if free | New binding for the new spawn |
| Mail or schedule addressed by session path | Deliver to the existing destination as before | Delivery never upgrades the recipient |
| Future delivery explicitly addressed to a bot run | Resolve on the execution host and check the recipient again on replay | Recipient only. Never infer the sender's identity from its address |
| Paired viewer | Existing viewing and delivery continue | The viewer cannot issue or assert a binding on the execution host |

A queued legacy report stays addressed to its original session even if the person later starts a host-issued home. It is ordinary mail. A future operation *requiring* the bot identity must never fall back to an ordinary tab, including during redelivery. No current operation needs that restriction.

## Scope and verification

1. Local issuance, call-source verification, and revocation. Exercise the actual host entrance. Reject identity claims in ordinary opens, child frames and outside calls. Distinguish a live issued chat from its restored tab, a different bot, a reused lane number after a core restart, and a reused file path. Cover ordinary occupation, duplicate opens, and a call received before revocation but processed after it.
2. Address issued runs from mail, wakes, and schedules without changing the path-only routes above. Keep ordinary delivery tests for a legacy-only bot and for queued work when both kinds of chat exist.
3. Run the dedicated launch on the paired execution host under that host's access policy. A matching bot ID on the viewer is not enough. A disconnected or older peer cannot establish a remote identity.

As in the [paired-web threat model](../../.omp/rules/multi-viewer-web.md#threat-model), processes running as the same OS user are not isolated. This design distinguishes executions along OMPdesk's supported host interfaces. It does not defend against a compromised execution host, a hostile process with the user's local access, or an agent following untrusted instructions. It does not authenticate a person or replace interactive approval.
