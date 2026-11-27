# Bots and their items

A bot is a folder on this computer (default `~/.omp/bots/<name>`); every session in that folder is one of its chats, the first one its home chat. `SOUL.md` there says who it is (the bot writes it on its first run; its first paragraph is the bot's specialty), `MEMORY.md` there is what it remembers (one fact per list line; it forgets a fact by deleting its line). The owner sees bots and items on the Bots page; only the owner deletes a bot.

## `ompdesk_bot`

`action`:
- `create` — `name`, `folder` (absolute; default `~/.omp/bots/<name>`, made unique). Makes the folder and sends nothing: the owner writes first. Asks the user first only when "Let agents manage other sessions" is off.
- `offer` — `name`, `text` (what it would do, one or two sentences): proposes a bot instead of making it. The owner sees a card in this chat with Create bot; nothing is made until they press it, so do not `create` it yourself afterwards. Prefer it when the owner has not asked for the bot by name.
- `list` — each bot with its folder, home chat, pause, specialty, open items and the items waiting on the owner.
- `pause` / `resume` — `bot` (name or id). A paused bot takes nothing: a send to one of its chats, a routine's wake-up and a hand-over are refused ("The bot <name> is paused"), and reports to it are held. `resume` hands each held report over once.
- `set` — `bot`, `model` (its new chats and routines; `""` = omp's default), `auto_approve` (its routines run every tool without asking), `stale_days` (an open item untouched this long reads stale; `0` never), `reach` (paired devices whose agents may message it; `[]` = this computer only).
- `rename` — `bot`, `name`: renames it, gives its own routines (`<name>: …`) the new name and tells its home chat to update its own files (SOUL.md, MEMORY.md). Its folder moves beside itself to the new name's slug, with its chats' sessions and its routines, when it sits inside `~/.omp/bots` with no link on its path; a folder outside it never moves, nor one that is, holds or sits in another bot's folder, or one whose new folder is taken. While a chat there runs a turn the folder moves once the turn ends. The same name moves a folder still named for an earlier name, once; when the folder already matches it does nothing.
- `look_around` — `bot` (default: the bot whose chat calls), and any of `on`, `every` (`every-4h`, the default, 8:00 to 20:00; `every-2h`; `twice-daily`, 8:00 and 13:00; `mornings`, 8:00), `weekdays_only` (default `true`), `focus` (what to look for, 500 characters; `""` = anything waiting on the owner). Only what it names changes. A new bot's is on; its schedule wakes the home chat once it has one. Change it only when the owner asks.
- `suggestions` — `bot` (default: the calling bot): its Suggestions list, what the owner started lately and what they dismissed. A look reads it first.
- `suggest` — from a bot's chat only: `suggestions`, this look's whole list (at most 5), each `{title, why, ask, link?}`: `title` what to do (80 characters), `why` one sentence on why now, `ask` the message the owner would send you to do it, written as them, `link` the thread, issue or pull request. It replaces the owner's Suggestions list (apart from items): one listed again keeps its place and age, `[]` clears the list. One the owner dismissed is refused for 30 days in any wording, and so is one that looks like it holds a credential.
- `hand` — `bot` (default: the calling bot), `session`, `text`: the bot's home chat becomes that session's opener (its reports go to the bot) and `text` reaches it as a message from the bot. From a bot's own chat it takes a session over: find it with `ompdesk_sessions`, and ask it where it stands. A worker cannot reassign work this way; message or report to its opener instead. A session the user is typing in is refused. Handed and opened sessions show on the bot's Activity as its workers, with their branches.
- `connectors` (from a bot's own chat) — where people can ask the bot and who may: its Slack app, the GitHub repositories and Linear workspace where `bot:<handle>` asks it, and what wakes it from the owner's Google account (calendar events, new Gmail; neither is answered by mail or invite). The owner adds them on the bot's page.
- `reply` — `to`, `text`: answers someone who asked the bot through a connector. `to` is the handle its run was told ("reply with ompdesk_bot reply to slack:…", `github:…`, `linear:…`), and only a connector of this bot is answered. Slack posts as the bot's own app; GitHub and Linear post as the owner and end with the bot's name, "via OMPdesk". Never comment there with `gh` yourself (that would answer twice). A turn with nothing to say posts nothing: end it with NO_REPLY.
- `offer_connector` — `service` (`slack`, `github`, `linear`, `google`): shows the owner a Connect card for that service in this chat, when a request needs one the bot lacks. Never ask the owner for a token.

A bot by name: `ompdesk_session_send {"session":"bot:<name>"}` reaches its home chat on this computer (opened in the background if closed); `bot:<name>@<device>` reaches a bot on a paired computer, which takes it only when this computer is in that bot's `reach`. `ompdesk_report {"to":"bot:<name>"}` and `ompdesk_schedule {"target":"bot:<name>"}` (a wake-up of its home chat in its folder, with its model) name a bot the same way.

## `ompdesk_item` (a bot's chat only)

`item` is its number (`3`, `#3`) or id. `action`:
- `add` — `title`, `description`, `done_means`, `status` (default `planned`).
- `set` — `item` and any of `status` (`planned`, `working`, `waiting`, `needs_you`, `done`, `canceled`), `title`, `description`, `done_means`, `ask` with `options` and `recommended` (a question only the owner can answer: the item becomes `needs_you`, and their answer reaches you as a message that starts a turn), `asks` (up to 5 questions at once, each `{question, options, recommended, multi}`; `ask` is then the words around them, and the owner answers them in one message, a line `Question → answer` each), `wait` with `until` (what it waits on outside you and the owner: the item becomes `waiting`), `snooze_until` (hidden until then; `""` wakes it). A new question or a close ends a snooze.
- `withdraw` — close your question when it no longer applies. Give the `item`, the `question` id and a `note` explaining why.
- `self_decide` — close your question only when the choice is yours to make. Give the same fields; in `note`, say what you chose and why.
- `comment` — `item`, `text`.
- `done` / `cancel` — `item`, `note`. A closed item adds `- YYYY-MM-DD | item #<n> | <status> | <title>` to `memory/journal/YYYY-MM.md` in the bot's folder and leaves the board 7 days later.
- `link` — `item` and one of `url`, `file`, `session`, `pr`.
- `list` — `status` (open ones by default). `show` — `item`.

Post the choice on the item, for example `{"action":"set","item":"3","ask":"Which release should get the fix?","options":["Current","Next"],"recommended":0}`. Continue unrelated work. A recommendation is not the owner's consent.

Use the current question id from `set`, `show`, or `list`. If the question changed, read it again. Closing a question removes it from the inbox, keeps the item working and records your note as the bot's, not the owner's. Leave work that requires the owner's answer blocked. Say whether you withdrew the question or decided it yourself, and that the owner did not answer.

Code work goes to sessions: `ompdesk_session_open {"message": …, "item": 3, "folder": <project>}` links each session it opens to the item and a planned item becomes working; a project folder in git opens in a worktree of its own unless you pass `worktree: false`. While every linked session waits for a usage limit the item says until when, and the item's Activity shows each linked session's done or blocked report. The owner's changes to an item reach you as quiet notes, once each; several items the owner moves at once are one note. A snooze alone is not sent.

## `ompdesk_room` (a bot's chat only)

A group is bots the owner put together; its room is where the owner posts and its members answer. A post asks the members the group's reply mode names (all, only those it @mentions, or one bot): you get a message with the post and the room's earlier posts since you last read it. `action`:
- `post` — `room` (id or group name), `text`: your answer in the room. `@Name` asks that member to answer too (a short chain only). Post nothing when you have nothing to add.
- `read` — `room`, `limit` (newest posts, default 20).
- `list` — your groups.
