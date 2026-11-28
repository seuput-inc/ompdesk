import { useRef, useState } from "react";
import { CLAUDE_API_URL } from "../../../../../resources/gui-bridge/claude-key-models";
import { ipcErrorCode } from "../../../../shared/ipc-error-codes";
import { useT } from "../../../lib/i18n";
import { useFocusedTabDevice } from "../../../stores/remote";
import { Banner, Button, Input, Modal } from "../../common";
import { useProviderLogin } from "./ProviderLogin";

export function useProviderConnection(
	onConnected: (id: string) => Promise<void>,
	onKeyConnected: (id: string) => void | Promise<void> = onConnected,
) {
	const t = useT();
	const device = useFocusedTabDevice();
	const login = useProviderLogin(onConnected);
	const [step, setStep] = useState<"choose" | "key" | null>(null);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const close = () => {
		if (!saving) setStep(null);
	};
	const connect = async (id: string) => {
		if (id !== "anthropic") return login.start(id);
		if (!login.busy) {
			setError("");
			setStep("choose");
		}
		return false;
	};
	const save = async () => {
		const apiKey = input.current?.value.trim();
		if (saving) return;
		if (!apiKey) {
			setError(t("providers.claude.keyRequired"));
			return;
		}
		setSaving(true);
		setError("");
		let id = "anthropic-api-key";
		try {
			const catalog = await window.omp.models.listProviders(device);
			for (let n = 2; catalog.providers.some(provider => provider.id === id); n++) id = `anthropic-api-key-${n}`;
			await window.omp.models.upsertProvider(
				{
					id,
					onlyIfAbsent: true,
					baseUrl: CLAUDE_API_URL,
					api: "anthropic-messages",
					auth: "apiKey",
					apiKey,
					models: [],
				},
				device,
			);
		} catch (reason) {
			setError(
				t(
					ipcErrorCode(reason) === "source_unavailable"
						? "providers.claude.noCatalog"
						: "providerCfg.toast.saveFailed",
				),
			);
			return;
		} finally {
			setSaving(false);
		}
		setStep(null);
		await onKeyConnected(id);
	};
	const claudePanel = step && (
		<Modal
			description={step === "key" ? t("providers.claude.keyHint") : undefined}
			onClose={close}
			open
			size="sm"
			title={t(step === "key" ? "providers.claude.keyTitle" : "providers.claude.choose")}
		>
			{step === "choose" ? (
				<div className="flex flex-col gap-3" data-claude-connect>
					<div className="grid gap-2 sm:grid-cols-2">
						<Button
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
			) : (
				<form
					className="flex flex-col gap-4"
					data-claude-key
					onSubmit={event => {
						event.preventDefault();
						void save();
					}}
				>
					<Input
						autoComplete="off"
						autoFocus
						disabled={saving}
						label={t("providerCfg.form.apiKey")}
						ref={input}
						required
						spellCheck={false}
						type="password"
					/>
					{error && (
						<Banner live variant="danger">
							{error}
						</Banner>
					)}
					<div className="flex justify-end gap-2">
						<Button disabled={saving} onClick={close} type="button" variant="secondary">
							{t("common.cancel")}
						</Button>
						<Button loading={saving} type="submit" variant="primary">
							{t("providers.featured.connect")}
						</Button>
					</div>
				</form>
			)}
		</Modal>
	);
	return {
		login: { ...login, start: connect },
		claudePanel,
		retryLogin: () => {
			if (login.state.providerId) void login.start(login.state.providerId);
		},
	};
}
