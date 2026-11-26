# Bots and their items

A bot is a folder on this computer (default `~/.omp/bots/<name>`); every session in that folder is one of its chats, the first one its home chat. `SOUL.md` there says who it is (the bot writes it on its first run; its first paragraph is the bot's specialty), `MEMORY.md` there is what it remembers (one fact per list line; it forgets a fact by deleting its line). The owner sees bots and items on the Bots page; only the owner deletes a bot.

## `ompdesk_bot`

`action`:
- `create` — `name`, `folder` (absolute; default `~/.omp/bots/<name>`, made unique). Makes the folder and sends nothing: the owner writes first. Asks the user first only when "Let agents manage other sessions" is off.
- `offer` — `name`, `text` (what it would do, one or two sentences): proposes a bot instead of making it. The owner sees a card in this chat with Create bot; nothing is made until they press it, so do not `create` it yourself afterwards. Prefer it when the owner has not asked for the bot by name.
- `list` — each bot with its folder, home chat, pause, specialty, open items and the items waiting on the owner.
- `pause` / `resume` — `bot` (name or id). A paused bot takes nothing: a send to one of its chats, a routine's wake-up and a hand-over are refused ("The bot <name> is paused"), and reports to it are held. `resume` hands each held report over once.
- `set` — `bot`, `model` (its new chats and routines; `""` = omp's default), `auto_approve` (its routines run every tool without asking), `stale_days` (an open item untouched this long reads stale; `0` never), `reach` (paired devices whose agents may message it; `[]` = this computer only).
- `look_around` — `bot`, `on`, `time` (HH:MM, default 09:00): a daily routine into its home chat that reads its projects read-only and saves at most 5 suggestions as planned items, ending with NO_REPLY when there is nothing to say. Each suggestion is an item the owner cancels on its own; there is no undo of a whole run.
- `hand` — `bot`, `session`, `text`: the bot's home chat becomes that session's opener (its reports go to the bot) and `text` reaches it as a message from the bot. A session the user is typing in is refused.
- `connectors` (from a bot's own chat) — where people can ask the bot and who may: its Slack app, the GitHub repositories and Linear workspace where `bot:<handle>` asks it, its Google calendar. The owner adds them on the bot's page.
- `reply` — `to`, `text`: answers someone who asked the bot through a connector. `to` is the handle its run was told ("reply with ompdesk_bot reply to slack:…", `github:…`, `linear:…`), and only a connector of this bot is answered. Slack posts as the bot's own app; GitHub and Linear post as the owner and end with the bot's name, "via OMPdesk". Never comment there with `gh` yourself (that would answer twice). A turn with nothing to say posts nothing: end it with NO_REPLY.
- `offer_connector` — `service` (`slack`, `github`, `linear`, `google`): shows the owner a Connect card for that service in this chat, when a request needs one the bot lacks. Never ask the owner for a token.

A bot by name: `ompdesk_session_send {"session":"bot:<name>"}` reaches its home chat on this computer (opened in the background if closed); `bot:<name>@<device>` reaches a bot on a paired computer, which takes it only when this computer is in that bot's `reach`. `ompdesk_report {"to":"bot:<name>"}` and `ompdesk_schedule {"target":"bot:<name>"}` (a wake-up of its home chat in its folder, with its model) name a bot the same way.

## `ompdesk_item` (a bot's chat only)

`item` is its number (`3`, `#3`) or id. `action`:
- `add` — `title`, `description`, `done_means`, `status` (default `planned`).
- `set` — `item` and any of `status` (`planned`, `working`, `waiting`, `needs_you`, `done`, `canceled`), `title`, `description`, `done_means`, `ask` with `options` and `recommended` (a question only the owner can answer: the item becomes `needs_you`, and their answer reaches you as a message that starts a turn), `asks` (up to 5 questions at once, each `{question, options, recommended, multi}`; `ask` is then the words around them, and the owner answers them in one message, a line `Question → answer` each), `wait` with `until` (what it waits on outside you and the owner: the item becomes `waiting`), `snooze_until` (hidden until then; `""` wakes it). A new question or a close ends a snooze.
- `comment` — `item`, `text`.
- `done` / `cancel` — `item`, `note`. A closed item adds `- YYYY-MM-DD | item #<n> | <status> | <title>` to `memory/journal/YYYY-MM.md` in the bot's folder and leaves the board 7 days later.
- `link` — `item` and one of `url`, `file`, `session`, `pr`.
- `list` — `status` (open ones by default). `show` — `item`.

Code work goes to sessions: `ompdesk_session_open {"message": …, "item": 3}` links each session it opens to the item and a planned item becomes working; while every linked session waits for a usage limit the item says until when, and the item's Activity shows each linked session's done or blocked report. The owner's changes to an item reach you as quiet notes, once each; several items the owner moves at once are one note. A snooze alone is not sent.

## `ompdesk_room` (a bot's chat only)

A group is bots the owner put together; its room is where the owner posts and its members answer. A post asks the members the group's reply mode names (all, only those it @mentions, or one bot): you get a message with the post and the room's earlier posts since you last read it. `action`:
- `post` — `room` (id or group name), `text`: your answer in the room. `@Name` asks that member to answer too (a short chain only). Post nothing when you have nothing to add.
- `read` — `room`, `limit` (newest posts, default 20).
- `list` — your groups.
