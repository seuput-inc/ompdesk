/**
 * A bot's settings the agent tool (main) and the bot's Settings page (a lazy chunk of the page) both bound, kept apart
 * from `bots.ts` so the paired phone's first screen does not carry them. The core refuses past each
 * (`journal/looks.rs`, `service/work/bots.rs`).
 *
 * Dependency-free.
 */

/** Look around's presets (Orca's `LOOK_AROUND_EVERY_CHOICES`). */
export const LOOK_EVERY = ["every-4h", "every-2h", "twice-daily", "mornings"] as const;
/** The longest Look around focus (Orca's `LOOK_AROUND_FOCUS_MAX_LENGTH`). */
export const LOOK_FOCUS_MAX = 500;
/** Projects whose skills a bot's chats load, at most (`SKILL_PROJECTS_MAX` of the core). */
export const BOT_SKILL_PROJECTS_MAX = 20;
/** A bot package file's name (`bot_package.rs` writes JSON): `<name>.ompdesk-bot.json`. */
export const BOT_PACKAGE_SUFFIX = ".ompdesk-bot.json";
