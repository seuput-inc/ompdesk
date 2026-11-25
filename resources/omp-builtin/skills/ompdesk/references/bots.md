# Bots and their items

A bot is a folder on this computer (default `~/.omp/bots/<name>`); every session in that folder is one of its chats, the first one its home chat. `SOUL.md` there says who it is (the bot writes it on its first run; its first paragraph is the bot's specialty), `MEMORY.md` there is what it remembers (one fact per list line; it forgets a fact by deleting its line). The owner sees bots and items on the Bots page; only the owner deletes a bot.

## `ompdesk_bot`

`action`:
- `create` — `name`, `folder` (absolute; default `~/.omp/bots/<name>`, made unique). Makes the folder and sends nothing: the owner writes first. Asks the user first only when "Let agents manage other sessions" is off.
- `list` — each bot with its folder, home chat, pause, specialty, open items and the items waiting on the owner.
- `pause` / `resume` — `bot` (name or id). A paused bot takes nothing: a send to one of its chats, a routine's wake-up and a hand-over are refused ("The bot <name> is paused"), and reports to it are held. `resume` hands each held report over once.
- `set` — `bot`, `model` (its new chats and routines; `""` = omp's default), `auto_approve` (its routines run every tool without asking), `stale_days` (an open item untouched this long reads stale; `0` never), `reach` (paired devices whose agents may message it; `[]` = this computer only).
- `look_around` — `bot`, `on`, `time` (HH:MM, default 09:00): a daily routine into its home chat that reads its projects read-only and saves at most 5 suggestions as planned items, ending with NO_REPLY when there is nothing to say. Each suggestion is an item the owner cancels on its own; there is no undo of a whole run.
- `hand` — `bot`, `session`, `text`: the bot's home chat becomes that session's opener (its reports go to the bot) and `text` reaches it as a message from the bot. A session the user is typing in is refused.

A bot by name: `ompdesk_session_send {"session":"bot:<name>"}` reaches its home chat on this computer (opened in the background if closed); `bot:<name>@<device>` reaches a bot on a paired computer, which takes it only when this computer is in that bot's `reach`. `ompdesk_report {"to":"bot:<name>"}` and `ompdesk_schedule {"target":"bot:<name>"}` (a wake-up of its home chat in its folder, with its model) name a bot the same way.

## `ompdesk_item` (a bot's chat only)

`item` is its number (`3`, `#3`) or id. `action`:
- `add` — `title`, `description`, `done_means`, `status` (default `planned`).
- `set` — `item` and any of `status` (`planned`, `working`, `waiting`, `needs_you`, `done`, `canceled`), `title`, `description`, `done_means`, `ask` with `options` and `recommended` (a question only the owner can answer: the item becomes `needs_you`, and their answer reaches you as a message that starts a turn), `wait` with `until` (what it waits on outside you and the owner: the item becomes `waiting`), `snooze_until` (hidden until then; `""` wakes it).
- `comment` — `item`, `text`.
- `done` / `cancel` — `item`, `note`. A closed item adds `- YYYY-MM-DD | item #<n> | <status> | <title>` to `memory/journal/YYYY-MM.md` in the bot's folder and leaves the board 7 days later.
- `link` — `item` and one of `url`, `file`, `session`, `pr`.
- `list` — `status` (open ones by default). `show` — `item`.

Code work goes to sessions: `ompdesk_session_open {"message": …, "item": 3}` links each session it opens to the item and a planned item becomes working; while every linked session waits for a usage limit the item says until when. The owner's changes to an item reach you as quiet notes, once each.
