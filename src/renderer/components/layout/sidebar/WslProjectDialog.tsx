import { useEffect, useId, useState } from "react";
import type { WslProjectHost } from "../../../../shared/ipc-types";
import { inlineFailure } from "../../../lib/error-detail";
import { useT } from "../../../lib/i18n";
import { openExternal } from "../../../lib/open-external";
import { Button, ChoiceList, LinkButton, Modal } from "../../common";

const GUIDES = [
	["config", "wsl-config"],
	["permissions", "file-permissions"],
	["container", "wsl-container"],
] as const;

export function WslProjectDialog({ cwd, name, onClose }: { cwd: string; name: string; onClose: () => void }) {
	const t = useT();
	const labelId = useId();
	const [hosts, setHosts] = useState<WslProjectHost | null>(null);
	const [chosen, setChosen] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void window.omp.wslHost.get(cwd).then(
			result => {
				if (!live) return;
				setChosen(result.selected);
				setHosts(result);
			},
			cause => {
				if (live) setError(inlineFailure(cause, t("sidebar.host.readFailed")).message);
			},
		);
		return () => {
			live = false;
		};
	}, [cwd, t]);
	const distributions = hosts?.distributions.filter(distro => distro.version === 2) ?? [];
	const unavailable = chosen !== null && !distributions.some(distro => distro.id === chosen);
	const canSave = hosts !== null && chosen !== hosts.selected && !unavailable && !saving;
	const save = async () => {
		if (!canSave) return;
		setSaving(true);
		setError(null);
		try {
			await window.omp.wslHost.set(cwd, chosen);
			onClose();
		} catch (cause) {
			setSaving(false);
			setError(inlineFailure(cause, t("sidebar.host.saveFailed")).message);
		}
	};
	return (
		<Modal
			footer={
				<>
					<Button disabled={saving} onClick={onClose} variant="secondary">
						{t("common.cancel")}
					</Button>
					<Button disabled={!canSave} onClick={save} variant="primary">
						{t("common.save")}
					</Button>
				</>
			}
			onClose={saving ? null : onClose}
			open
			size="sm"
			title={t("sidebar.host.title", { name })}
		>
			<div className="flex flex-col gap-2 text-sc-sm">
				<span id={labelId}>{t("sidebar.host.choose")}</span>
				{hosts && (
					<ChoiceList
						choices={[
							{ key: "", label: t("sidebar.host.windows"), disabled: saving },
							...distributions.map(distro => ({
								key: distro.id,
								label: `WSL 2 · ${distro.name}`,
								disabled: saving,
							})),
						]}
						labelledBy={labelId}
						mode="single"
						onChoose={key => setChosen(key || null)}
						selected={new Set([chosen ?? ""])}
					/>
				)}
				{unavailable && <p role="status">{t("sidebar.host.unavailable")}</p>}
				{chosen !== null && !unavailable && (
					<div className="flex flex-col gap-1 text-(--sc-text-secondary)">
						<p>{t("sidebar.host.notice")}</p>
						<div className="flex flex-wrap gap-x-3 gap-y-1">
							{GUIDES.map(([label, page]) => (
								<LinkButton
									key={page}
									onClick={() => openExternal(`https://learn.microsoft.com/en-us/windows/wsl/${page}`)}
								>
									{t(`sidebar.host.${label}`)}
								</LinkButton>
							))}
						</div>
					</div>
				)}
				{error && <p role="alert">{error}</p>}
			</div>
		</Modal>
	);
}
