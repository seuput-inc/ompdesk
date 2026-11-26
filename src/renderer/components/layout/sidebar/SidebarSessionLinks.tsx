/**
 * The links a person or an agent attached to a session (`stores/session-links.ts`; Orca's workspace links,
 * `WorktreeLinkedItemsField.tsx` and `MobileLinkPrForm.tsx`, MIT): the row says them in its tooltip and screen-reader
 * text (line 2 keeps the owner's approved contents, panels-sidebar.md › The row: two fixed lines), and the row menu's
 * "Link a PR or issue…" opens the dialog that adds and removes them.
 */
import { X } from "lucide-react";
import { useState } from "react";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { type SessionLink, sessionLink, sessionLinkLabel } from "../../../../shared/session-links";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { useSessionLinks } from "../../../stores/session-links";
import { Badge, Button, IconButton, Input, LinkButton, Modal } from "../../common";

const KIND_KEY: Record<SessionLink["kind"], string> = {
	pr: "sidebar.links.kind.pr",
	issue: "sidebar.links.kind.issue",
	url: "sidebar.links.kind.url",
};

/** A row's links in words for its tooltip: their count, then each one; null without links. */
export function sessionLinksWords(
	t: (key: string, params?: Record<string, string | number>) => string,
	links: readonly SessionLink[],
): string | null {
	if (!links.length) return null;
	return [t("sidebar.links.tip", { count: links.length }), ...links.map(sessionLinkLabel)].join("\n");
}

/** Adds and removes a session's links; each link opens in the browser. */
export function SessionLinksDialog({ sessionPath, onClose }: { sessionPath: string; onClose: () => void }) {
	const t = useT();
	const links = useSessionLinks(sessionPath);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const valid = sessionLink(input) !== null;

	const run = async (call: () => Promise<RpcResponse>): Promise<boolean> => {
		setBusy(true);
		setError(null);
		try {
			const response = await call();
			if (!response.success) setError(response.error ?? t("sidebar.links.failed"));
			return response.success;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			description={t("sidebar.links.description")}
			footer={
				<>
					<Button onClick={onClose} variant="ghost">
						{t("common.close")}
					</Button>
					<Button
						disabled={!valid}
						disabledReason={t("sidebar.links.invalid")}
						form="session-links-add"
						loading={busy}
						type="submit"
						variant="primary"
					>
						{t("sidebar.links.add")}
					</Button>
				</>
			}
			onClose={onClose}
			open
			size="md"
			title={t("sidebar.links.title")}
		>
			<form
				className="flex flex-col gap-3"
				data-session-links-dialog
				id="session-links-add"
				onSubmit={event => {
					event.preventDefault();
					if (!valid || busy) return;
					void run(() => window.omp.rpc.sessionLinkAdd(sessionPath, input.trim())).then(done => {
						if (done) setInput("");
					});
				}}
			>
				<Input
					error={error ?? undefined}
					label={t("sidebar.links.input")}
					mono
					onChange={event => {
						setInput(event.target.value);
						setError(null);
					}}
					placeholder="https://github.com/owner/repo/pull/123"
					type="url"
					value={input}
				/>
				{links.length === 0 ? (
					<p className="text-sc-sm text-(--sc-text-muted)">{t("sidebar.links.empty")}</p>
				) : (
					<ul className="flex flex-col gap-1">
						{links.map(link => (
							<li className="flex min-w-0 items-center gap-2" data-session-link={link.url} key={link.url}>
								<Badge size="xs" variant="default">
									{t(KIND_KEY[link.kind])}
								</Badge>
								<LinkButton
									className="min-w-0 truncate text-left"
									onClick={() => openExternal(link.url)}
									type="button"
								>
									{sessionLinkLabel(link)}
								</LinkButton>
								<IconButton
									className="ml-auto"
									icon={<X />}
									label={t("sidebar.links.remove", { link: sessionLinkLabel(link) })}
									onClick={() => void run(() => window.omp.rpc.sessionLinkRemove(sessionPath, link.url))}
									size="sm"
								/>
							</li>
						))}
					</ul>
				)}
			</form>
		</Modal>
	);
}
