/**
 * Connect a Linear workspace (a personal API key) or a Jira site (Cloud: email and API token, or a scoped token through
 * Atlassian's gateway; Server/Data Center: a personal access token, or a user and password). The token goes to this
 * computer's main once and never comes back (`src/main/tracker-accounts.ts`). Orca's "Connect Linear" sign-in is Orca
 * Cloud's and is not offered (Orca `linear-login-store.ts:10-23`).
 */
import { useId, useState } from "react";
import type { JiraAuthType, TrackerProvider, TrackersState } from "../../../../shared/trackers";
import { type InlineFailure, inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { trackerErrorText } from "../../../lib/trackers";
import { Button, FieldLabel, InlineNotice, Input, LinkButton, SegmentedChoice } from "../../common";

const LINEAR_KEYS_URL = "https://linear.app/settings/account/security";
const ATLASSIAN_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

export function TrackerConnectForm({
	provider,
	formId,
	onConnected,
	onBusy,
}: {
	provider: TrackerProvider;
	formId: string;
	onConnected: (state: TrackersState) => void;
	onBusy?: (busy: boolean) => void;
}) {
	const t = useT();
	const authId = useId();
	const [apiKey, setApiKey] = useState("");
	const [siteUrl, setSiteUrl] = useState("");
	const [email, setEmail] = useState("");
	const [token, setToken] = useState("");
	const [authType, setAuthType] = useState<JiraAuthType>("cloud");
	const [error, setError] = useState<InlineFailure | null>(null);
	const ready = provider === "linear" ? apiKey.trim() !== "" : siteUrl.trim() !== "" && token.trim() !== "";
	const submit = async () => {
		if (!ready) return;
		setError(null);
		onBusy?.(true);
		try {
			const state = await window.omp.trackers.accounts({
				action: "connect",
				draft: provider === "linear" ? { provider, apiKey } : { provider, siteUrl, email, token, authType },
			});
			setApiKey("");
			setToken("");
			onConnected(state);
		} catch (cause) {
			const failure = inlineFailure(cause, t("trackers.connectFailed"));
			setError({ message: failure.message, cause: trackerErrorText(cause) });
		} finally {
			onBusy?.(false);
		}
	};
	return (
		<form
			className="flex flex-col gap-3"
			data-tracker-connect={provider}
			id={formId}
			onSubmit={event => {
				event.preventDefault();
				void submit();
			}}
		>
			{provider === "linear" ? (
				<>
					<Input
						autoComplete="off"
						hint={t("trackers.linear.keyHint")}
						label={t("trackers.linear.key")}
						onChange={event => setApiKey(event.target.value)}
						type="password"
						value={apiKey}
					/>
					<LinkButton onClick={() => openExternal(LINEAR_KEYS_URL)} tone="accent">
						{t("trackers.linear.keyLink")}
					</LinkButton>
				</>
			) : (
				<>
					<div className="flex flex-col gap-1.5">
						<FieldLabel as="span" id={authId}>
							{t("trackers.jira.kind")}
						</FieldLabel>
						<SegmentedChoice
							aria-labelledby={authId}
							fit="content"
							onChange={setAuthType}
							optionAttr="data-jira-auth"
							options={[
								{ value: "cloud", label: t("trackers.jira.cloud") },
								{ value: "server", label: t("trackers.jira.server") },
							]}
							value={authType}
						/>
					</div>
					<Input
						autoComplete="url"
						label={t("trackers.jira.site")}
						onChange={event => setSiteUrl(event.target.value)}
						placeholder={authType === "cloud" ? "your-team.atlassian.net" : "jira.example.com"}
						value={siteUrl}
					/>
					<Input
						autoComplete="email"
						hint={t(authType === "cloud" ? "trackers.jira.emailHintCloud" : "trackers.jira.emailHintServer")}
						label={t(authType === "cloud" ? "trackers.jira.email" : "trackers.jira.user")}
						onChange={event => setEmail(event.target.value)}
						value={email}
					/>
					<Input
						autoComplete="off"
						label={t(
							authType === "cloud"
								? "trackers.jira.token"
								: email.trim()
									? "trackers.jira.password"
									: "trackers.jira.pat",
						)}
						onChange={event => setToken(event.target.value)}
						type="password"
						value={token}
					/>
					{authType === "cloud" && (
						<LinkButton onClick={() => openExternal(ATLASSIAN_TOKENS_URL)} tone="accent">
							{t("trackers.jira.tokenLink")}
						</LinkButton>
					)}
				</>
			)}
			{error && <InlineNotice detail={error.cause} live title={error.message} tone="danger" />}
		</form>
	);
}

/** The form with its own Connect button: the first account of a provider, shown in place of the list. */
export function TrackerConnectCard({
	provider,
	onConnected,
}: {
	provider: TrackerProvider;
	onConnected: (state: TrackersState) => void;
}) {
	const t = useT();
	const formId = useId();
	const [busy, setBusy] = useState(false);
	return (
		<div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-6 py-8" data-tracker-connect-card={provider}>
			<div className="flex flex-col gap-1">
				<h2 className="text-sc-lg font-semibold text-(--sc-text)">{t(`trackers.${provider}.connectTitle`)}</h2>
				<p className="text-sc-sm text-(--sc-text-secondary)">{t(`trackers.${provider}.connectHint`)}</p>
			</div>
			<TrackerConnectForm formId={formId} onBusy={setBusy} onConnected={onConnected} provider={provider} />
			<div>
				<Button form={formId} loading={busy} type="submit" variant="primary">
					{t("trackers.connect")}
				</Button>
			</div>
		</div>
	);
}
