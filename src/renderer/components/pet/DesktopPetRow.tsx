/**
 * Settings › Appearance & input › Desktop pet: the switch for the pet (pref `desktopPet`, off by default) and, while
 * it is on, the sprite choice the pet's own context menu offers too. Desktop windows only: a phone page draws no pet.
 */
import { PawPrint } from "lucide-react";
import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { webRuntime } from "../../web/runtime";
import { Button } from "../common";
import { SettingsSwitchRow } from "../settings/SettingsLayout";
import { useSpritePicker } from "./PetOverlay";
import { followPetPrefs, resetPetSprite, setPetEnabled, usePetPrefs } from "./pet-prefs";

export function DesktopPetRow() {
	const t = useT();
	const enabled = usePetPrefs(state => state.enabled);
	const sprite = usePetPrefs(state => state.sprite);
	const picker = useSpritePicker();
	useEffect(() => followPetPrefs(), []);
	if (webRuntime() !== null) return null;
	return (
		<SettingsSwitchRow
			checked={enabled}
			description={t("settings.gui.desktopPetDesc")}
			footer={
				enabled ? (
					<div className="flex flex-wrap gap-2">
						<Button onClick={picker.open} size="sm">
							{t("pet.chooseSprite")}
						</Button>
						{sprite && (
							<Button onClick={() => void resetPetSprite()} size="sm" variant="ghost">
								{t("pet.useDefaultSprite")}
							</Button>
						)}
						{picker.input}
					</div>
				) : undefined
			}
			icon={<PawPrint />}
			id="setting-gui-desktopPet"
			label={t("settings.gui.desktopPet")}
			onCheckedChange={next => void setPetEnabled(next)}
		/>
	);
}
