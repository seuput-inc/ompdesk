/**
 * A bot's Slack thread chat (one per Slack thread or direct message that asked it, the core's
 * `routines/slack_mirror.rs`): a bar over its transcript saying the owner's messages post to that thread, with the
 * chat's switch and what became of each recent message (Orca `slack-mirror-state.ts:1-140` and the native chat's
 * mirror badges: posting, posted with Delete from Slack, failed with Retry and Dismiss; a Slack Connect thread stays
 * off until turned on). Any other chat, the bot's home chat among them, shows nothing: it never posts.
 */
import { Hash } from "lucide-react";
import { useState } from "react";
import type { SlackMirrorAction, SlackMirrorPost, SlackThreadChat } from "../../../shared/schedules";
import { useT } from "../../lib/i18n";
import { openExternal } from "../../lib/open-external";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import { Badge, Button, Card, Switch } from "../common";
import { useLocalSchedules } from "./bot-automations";

/** Posted messages shown besides every failed one. */
const SHOWN_POSTS = 3;

/** Whether the chat is set to post: on, not blocked, and no Slack Connect thread left off (Orca `slackMirrorMayPost`). */
function mirrorOn(chat: SlackThreadChat): boolean {
	return chat.mirror !== false && !chat.blocked && (chat.chosen === true || chat.external !== true);
}

function statusKey(chat: SlackThreadChat): string {
	if (chat.blocked) return `bots.mirror.blocked.${chat.blocked}`;
	if (chat.mirror === false) return "bots.mirror.off";
	if (chat.external === true && chat.chosen !== true) return "bots.mirror.connect";
	return "bots.mirror.on";
}

export default function SlackThreadBar({ tabId }: { tabId: string }) {
	const t = useT();
	const session = useTabsStore(s => s.tabs.find(tab => tab.id === tabId && !tab.device)?.sessionPath);
	const schedules = useLocalSchedules();
	const [busy, setBusy] = useState(false);
	if (!session) return null;
	const found = Object.entries(schedules.threads ?? {}).flatMap(([id, chats]) =>
		chats.filter(chat => chat.session === session).map(chat => ({ id, chat })),
	)[0];
	if (!found) return null;
	const { id, chat } = found;
	const channel = chat.key.split(":")[1];
	const act = (change: SlackMirrorAction) => {
		setBusy(true);
		window.omp.schedules
			.command({ action: "mirror", ...change })
			.then(() => setBusy(false))
			.catch((error: unknown) => {
				setBusy(false);
				toastError({ title: t("bots.mirror.failed"), error });
			});
	};
	const posts = chat.posts ?? [];
	const shown: SlackMirrorPost[] = [
		...posts.filter(post => post.state === "failed"),
		...posts.filter(post => post.state !== "failed").slice(0, SHOWN_POSTS),
	];
	return (
		<Card className="absolute inset-x-4 top-2 z-10 flex flex-col gap-2" data-slack-thread-bar={chat.key} padding="sm">
			<div className="flex items-center gap-2">
				<Hash aria-hidden className="size-4 shrink-0 text-(--sc-text-muted)" />
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="text-sc-sm font-medium">{t("bots.mirror.title")}</span>
					<span className="text-sc-xs text-(--sc-text-muted)">{t(statusKey(chat))}</span>
				</div>
				{channel && (
					<Button
						onClick={() => openExternal(`https://slack.com/app_redirect?channel=${encodeURIComponent(channel)}`)}
						size="sm"
						variant="ghost"
					>
						{t("bots.mirror.open")}
					</Button>
				)}
				<Switch
					checked={mirrorOn(chat)}
					disabled={busy}
					label={t("bots.mirror.switch")}
					onCheckedChange={next => act({ op: "set", id, key: chat.key, on: next })}
				/>
			</div>
			{shown.length > 0 && (
				<ul className="flex flex-col gap-1">
					{shown.map(post => (
						<li className="flex min-w-0 items-center gap-2 text-sc-xs" data-slack-post={post.state} key={post.id}>
							<Badge
								size="xs"
								variant={post.state === "failed" ? "error" : post.state === "posted" ? "success" : "muted"}
							>
								{t(`bots.mirror.post.${post.state}`)}
							</Badge>
							<span className="min-w-0 flex-1 truncate" title={post.error ?? post.text}>
								{post.text}
							</span>
							{post.state === "failed" && (
								<>
									<Button
										disabled={busy}
										onClick={() => act({ op: "retry", id, key: chat.key, post: post.id })}
										size="sm"
										variant="ghost"
									>
										{t("bots.mirror.retry")}
									</Button>
									<Button
										disabled={busy}
										onClick={() => act({ op: "dismiss", id, key: chat.key, post: post.id })}
										size="sm"
										variant="ghost"
									>
										{t("bots.mirror.dismiss")}
									</Button>
								</>
							)}
							{post.state === "posted" && (
								<Button
									disabled={busy}
									onClick={() => act({ op: "delete", id, key: chat.key, post: post.id })}
									size="sm"
									variant="ghost"
								>
									{t("bots.mirror.delete")}
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
