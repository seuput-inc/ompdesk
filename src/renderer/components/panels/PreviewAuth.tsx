/**
 * A server asks the person to sign in to load the Preview's page (HTTP basic or digest auth; Orca's
 * `page-prompts/browser-http-auth-prompt.ts`). A dialog, so the native page view hides under it. The name and password
 * go to that one challenge (`authAnswer`) and nothing keeps them: no history, no store, no autofill.
 */
import { useEffect, useState } from "react";
import type { PreviewAuthPrompt } from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { Button, Input, Modal } from "../common";

export function PreviewAuthDialog({
	auth,
	onAnswer,
}: {
	auth: PreviewAuthPrompt | null;
	/** The name and password, or null to cancel (the page shows the server's refusal). */
	onAnswer: (id: number, answer: { username: string; password: string } | null) => void;
}) {
	const t = useT();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const id = auth?.id;
	// A new prompt starts empty; what was typed for the last one is gone.
	// biome-ignore lint/correctness/useExhaustiveDependencies: cleared per prompt
	useEffect(() => {
		setUsername("");
		setPassword("");
	}, [id]);
	const answer = (value: { username: string; password: string } | null) => {
		if (id !== undefined) onAnswer(id, value);
		setPassword("");
	};
	return (
		<Modal
			open={auth !== null}
			onClose={() => answer(null)}
			size="sm"
			title={t("panel.preview.auth.title")}
			description={
				auth &&
				(auth.realm
					? t("panel.preview.auth.bodyRealm", { origin: auth.origin, realm: auth.realm })
					: t("panel.preview.auth.body", { origin: auth.origin }))
			}
			footer={
				<>
					<Button size="sm" variant="secondary" onClick={() => answer(null)}>
						{t("common.cancel")}
					</Button>
					<Button size="sm" variant="primary" type="submit" form="preview-auth">
						{t("panel.preview.auth.signIn")}
					</Button>
				</>
			}
		>
			<form
				className="flex flex-col gap-2"
				data-preview-auth
				id="preview-auth"
				onSubmit={event => {
					event.preventDefault();
					answer({ username, password });
				}}
			>
				<Input
					autoComplete="off"
					label={t("panel.preview.auth.username")}
					onChange={event => setUsername(event.target.value)}
					value={username}
				/>
				<Input
					autoComplete="off"
					label={t("panel.preview.auth.password")}
					onChange={event => setPassword(event.target.value)}
					type="password"
					value={password}
				/>
				<p className="text-sc-xs text-(--sc-text-muted)">{t("panel.preview.auth.notKept")}</p>
			</form>
		</Modal>
	);
}
