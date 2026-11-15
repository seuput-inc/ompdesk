import { Suspense, useEffect } from "react";
import { lazyChunk } from "../../lib/chunk-load";
import { useMailReentryAccounts, useMailReentryStore } from "../../stores/mail-reentry";

const MailReentryNotice = lazyChunk(() =>
	import("./MailReentryNotice").then(m => ({ default: m.MailReentryNotice })),
);

export function MailReentryNoticeGate() {
	const accounts = useMailReentryAccounts();
	const refresh = useMailReentryStore(state => state.refresh);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	if (accounts.length === 0) return null;
	return (
		<Suspense fallback={null}>
			<MailReentryNotice />
		</Suspense>
	);
}
