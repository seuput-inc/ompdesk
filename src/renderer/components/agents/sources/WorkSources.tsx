/**
 * Agents › GitHub's work-source bar (Orca `task-page/SourceBar.tsx:1-238`, FK-T01): GitHub over gh, GitLab over glab,
 * Linear and Jira over their APIs with this computer's connections. The source chosen last is kept while the app runs.
 */
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { SegmentedChoice } from "../../common";
import { GithubCenter } from "../github/GithubCenter";
import { GitlabCenter } from "./GitlabCenter";
import { TrackerCenter } from "./TrackerCenter";

const SOURCES = ["github", "gitlab", "linear", "jira"] as const;
type Source = (typeof SOURCES)[number];

let lastSource: Source = "github";

export function WorkSources() {
	const t = useT();
	const [source, setSource] = useState<Source>(lastSource);
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-work-sources={source}>
			<div className="flex shrink-0 items-center border-b border-(--sc-divider) px-6 pt-3 pb-2 min-[1280px]:px-10">
				<SegmentedChoice
					aria-label={t("workSources.label")}
					fit="content"
					onChange={next => {
						lastSource = next;
						setSource(next);
					}}
					optionAttr="data-work-source"
					options={SOURCES.map(value => ({ value, label: t(`workSources.${value}`) }))}
					value={source}
				/>
			</div>
			{source === "github" ? (
				<GithubCenter />
			) : source === "gitlab" ? (
				<GitlabCenter />
			) : (
				<TrackerCenter key={source} provider={source} />
			)}
		</div>
	);
}
