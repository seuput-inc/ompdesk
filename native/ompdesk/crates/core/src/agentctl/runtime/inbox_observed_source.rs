//! The Root's borrowed card proof admits one host-observed report into the existing source journal.
//! This synchronous effect belongs inside RemoteCard::admit; its result is source persistence only.

use serde::Deserialize;
use serde_json::Value;

use super::Runtime;
use crate::agentctl::inbox::{
    HostObservedCardPrincipal, InboxAddress, InboxIntent, InboxLogicalMessage, InboxLogicalPayload,
    InboxLogicalSource, InboxProducer, ObservedCardKind,
};
use crate::agentctl::journal::Persistence;
use crate::agentctl::journal::mail_outbox::OutboxMail;
use crate::agentctl::rules::mail::{Mail, MailKind, delivery_for, mail_details, mail_text};
use crate::agentctl::service::text::card_text;
use crate::agentctl::service::types::UiRequest;
use crate::application::observed_cards::VerifiedCard;
use crate::server::Fault;

impl Runtime {
    /// No JSON or tool entry point. The proof is borrowed from the Root's final synchronous admission.
    /// A later disconnect cannot withdraw a source obligation already persisted by this call.
    pub(crate) fn keep_observed_card(&self, card: &VerifiedCard<'_>) -> Result<Persistence, Fault> {
        if self.host().state().device_id != card.observer_host {
            return Err(Fault::new(
                "observed_card_host_changed",
                "The source journal does not belong to this observing host",
            ));
        }
        let outbox = self.host().outbox().ok_or_else(|| {
            Fault::new(
                "observed_card_journal_missing",
                "The observing host has no source report journal",
            )
        })?;
        let request = UiRequest::deserialize(card.request)
            .map_err(|error| Fault::new("observed_card_invalid_request", error.to_string()))?;
        let text = format!(
            "OMPdesk host observed this question card; this is not a report written by the child:\n{}",
            card_text(&request),
        );
        let title = if card.subject_title.is_empty() {
            card.subject_task.unwrap_or("")
        } else {
            card.subject_title
        };
        let request_id = format!("ask-{}", card.card_id);
        let mut mail = Mail::new(
            &request_id,
            card.subject_tab,
            title,
            card.recipient_tab,
            MailKind::Question,
            &text,
            0.0,
        );
        mail.card = Some(card.card_id.to_owned());
        let Value::Object(mut logical_details) = mail_details(&mail) else {
            unreachable!("mail_details returns an object")
        };
        logical_details.remove("from");
        logical_details.remove("fromTitle");
        // The complete issuer-verified body participates in conflict detection even when card_text omits a field.
        logical_details.insert("observedRequest".into(), card.request.clone());
        let logical = InboxLogicalMessage {
            producer: InboxProducer::HostObservedCard(Box::new(HostObservedCardPrincipal {
                kind: ObservedCardKind::HostObservedCard,
                observer_host: card.observer_host.to_owned(),
                subject: InboxAddress {
                    device_id: card.subject_host.to_owned(),
                    session_path: card.subject_path.to_owned(),
                },
                omp_epoch: card.omp_epoch.to_owned(),
                card_id: card.card_id.to_owned(),
            })),
            target: InboxAddress {
                device_id: card.recipient_host.unwrap_or(card.observer_host).to_owned(),
                session_path: card.recipient_path.to_owned(),
            },
            request_id: Some(request_id),
            intent: InboxIntent::Immediate,
            trigger_turn: true,
            payload: InboxLogicalPayload::Report {
                text,
                details: logical_details,
                instruction: None,
                card: Some(card.card_id.to_owned()),
            },
        };
        let delivery_id = logical
            .delivery_id()
            .map_err(|error| Fault::new("observed_card_invalid_identity", error))?;
        // Actual tab/title/task are display metadata, never part of the stable principal or fingerprint.
        mail.id = format!("ask-{}-{}", card.subject_tab, card.card_id);
        let content = mail_text(&mail);
        let details = mail_details(&mail);
        // The same ordinal and lock order as Execution keep_source, not a second source queue or counter.
        let mut last = super::lock(&self.source_at);
        let at = self.control.now().max(*last + 1.0);
        *last = at;
        outbox
            .keep(OutboxMail {
                id: mail.id,
                session_path: card.recipient_path.to_owned(),
                device: card.recipient_host.map(str::to_owned),
                from: Some(card.subject_path.to_owned()),
                from_device: Some(card.subject_host.to_owned()),
                logical_content: Some(content.clone()),
                content,
                details,
                delivery_id: Some(delivery_id),
                native_source: InboxLogicalSource::Bound(logical),
                delivery: delivery_for(MailKind::Question),
                attachments: None,
                attachments_corrupt: false,
                at,
            })
            .map_err(|error| Fault::new("observed_card_persistence_failed", error))
    }
}
