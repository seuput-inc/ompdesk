import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { Banner, Button, SkeletonRows } from "../../common";
import { CustomProviderForm } from "./CustomProviderForm";
import type { ProviderCatalog } from "./ProviderList";
import { useProviderLogin } from "./ProviderLogin";

/** The picker and Add account both enter here. Only the subscription button starts stock's Claude login. */
export function useProviderConnection(catalog: ProviderCatalog, onConnected: (id: string) => Promise<void>) {
	const t = useT();
	const login = useProviderLogin(onConnected);
	const [step, setStep] = useState<"choose" | "key" | null>(null);
	const close = () => setStep(null);
	const connect = async (id: string) => {
		if (id !== "anthropic") return login.start(id);
		if (!login.busy) setStep("choose");
		return false;
	};
	let claudePanel = null;
	if (step === "choose") {
		claudePanel = (
			<div className="flex flex-col gap-3" data-claude-connect>
				<h3 className="text-sc-lg font-semibold text-(--sc-text)">{t("providers.claude.choose")}</h3>
				<div className="grid gap-2 sm:grid-cols-2">
					<Button
						autoFocus
						onClick={() => {
							close();
							void login.start("anthropic");
						}}
						variant="secondary"
					>
						{t("providers.featured.subscription")}
					</Button>
					<Button onClick={() => setStep("key")} variant="secondary">
						{t("providers.featured.apiKey")}
					</Button>
				</div>
				<Button className="self-end" onClick={close} variant="ghost">
					{t("common.cancel")}
				</Button>
			</div>
		);
	} else if (step === "key") {
		claudePanel =
			catalog.options && !catalog.configError ? (
				<CustomProviderForm
					claudeKey
					editing={null}
					existing={catalog.customConfigs}
					onCancel={close}
					onSaved={id => {
						close();
						void onConnected(id);
					}}
					options={catalog.options}
				/>
			) : (
				<div className="flex flex-col gap-2">
					{catalog.configError ? (
						<Banner
							actions={<Button onClick={() => void catalog.load(true)}>{t("common.retry")}</Button>}
							variant="warning"
						>
							{t("setup.configReadFailed")}
						</Banner>
					) : (
						<SkeletonRows label={t("modelPicker.loading")} widths={[60, 44]} />
					)}
					<Button className="self-end" onClick={close} variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			);
	}
	return {
		login: { ...login, start: connect },
		claudePanel,
		retryLogin: () => {
			if (login.state.providerId) void login.start(login.state.providerId);
		},
	};
}
