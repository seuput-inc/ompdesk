/**
 * A running iOS Simulator's or Android device's screen in the Preview (Orca's emulator pane, `emulator-pane/**`): the
 * core takes a picture every `SCREEN_MS` while the panel shows (`simctl io screenshot`, `adb exec-out screencap`). On
 * Android a click is a tap at that pixel and Back, Home and Recents are its keys; a Simulator takes touches only through
 * its own window, so its screen is shown, not driven. Nothing is booted here: the agent does that with the
 * `mobile-emulator` skill.
 */
import { ArrowLeft, Circle, Square, X } from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import type { PreviewDevice } from "../../../shared/preview";
import { useT } from "../../lib/i18n";
import { ErrorDetail, IconButton } from "../common";

/** How often the screen is read while it shows. */
export const SCREEN_MS = 700;

/** This computer's running devices, read once when `active`; empty until they answer or when none runs. */
export function useRunningDevices(active: boolean): PreviewDevice[] {
	const [devices, setDevices] = useState<PreviewDevice[]>([]);
	useEffect(() => {
		if (!active) return;
		let live = true;
		window.omp.preview.device({ action: "list" }).then(
			listed => live && setDevices(listed),
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [active]);
	return devices;
}

export function PreviewDeviceScreen({
	device,
	active,
	onClose,
}: {
	device: PreviewDevice;
	/** The panel shows: the screen is read only then. */
	active: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const [screen, setScreen] = useState<string | null>(null);
	const [error, setError] = useState<unknown>(null);
	useEffect(() => {
		if (!active) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const read = () => {
			window.omp.preview
				.device({ action: "screen", platform: device.platform, id: device.id })
				.then(
					png => {
						if (!live) return;
						setScreen(png);
						setError(null);
					},
					(failure: unknown) => live && setError(failure),
				)
				.finally(() => {
					if (live) timer = setTimeout(read, SCREEN_MS);
				});
		};
		read();
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [active, device.platform, device.id]);
	const android = device.platform === "android";
	const press = (key: "back" | "home" | "apps") =>
		void window.omp.preview
			.device({ action: "key", id: device.id, key })
			.catch((failure: unknown) => setError(failure));
	const tap = (event: MouseEvent<HTMLImageElement>) => {
		const shown = event.currentTarget;
		const box = shown.getBoundingClientRect();
		if (!box.width || !box.height) return;
		const x = Math.round(((event.clientX - box.left) / box.width) * shown.naturalWidth);
		const y = Math.round(((event.clientY - box.top) / box.height) * shown.naturalHeight);
		void window.omp.preview
			.device({ action: "tap", id: device.id, x, y })
			.catch((failure: unknown) => setError(failure));
	};
	return (
		<div className="flex h-full min-h-0 flex-col" data-preview-device={device.platform}>
			<div className="flex min-w-0 items-center gap-1 border-b border-(--sc-divider) px-3 py-1">
				<span className="min-w-0 flex-1 truncate text-sc-xs font-medium text-(--sc-text)">{device.name}</span>
				{android && (
					<>
						<IconButton
							icon={<ArrowLeft />}
							label={t("panel.preview.device.back")}
							onClick={() => press("back")}
							size="sm"
						/>
						<IconButton
							icon={<Circle />}
							label={t("panel.preview.device.home")}
							onClick={() => press("home")}
							size="sm"
						/>
						<IconButton
							icon={<Square />}
							label={t("panel.preview.device.apps")}
							onClick={() => press("apps")}
							size="sm"
						/>
					</>
				)}
				<IconButton icon={<X />} label={t("panel.preview.device.close")} onClick={onClose} size="sm" />
			</div>
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-auto p-3">
				{screen && (
					<img
						alt={t("panel.preview.device.screen", { name: device.name })}
						className={`max-h-full max-w-full rounded-(--sc-radius-md) border border-(--sc-border) object-contain ${android ? "cursor-pointer" : ""}`}
						onClick={android ? tap : undefined}
						src={`data:image/png;base64,${screen}`}
					/>
				)}
				{!android && <p className="text-sc-xs text-(--sc-text-muted)">{t("panel.preview.device.iosHint")}</p>}
				{error !== null && <ErrorDetail className="break-words" error={error} />}
			</div>
		</div>
	);
}
