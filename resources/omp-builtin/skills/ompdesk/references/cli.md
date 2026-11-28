# The `ompdesk` CLI

People, scripts and `task` subagents (which have no host tools) can use the CLI from any shell while OMPdesk is running. Unlike the session tools, CLI `open` and `send` have no opener or sender session. `ompdesk help` lists the commands; `ompdesk help <command>` lists its flags.

Commands: `sessions`, `open`, `send`, `wait`, `state`, `result`, `read`, `answer`, `stop`, `show`, `notify`, `compare`, `merge`, `report`, `schedule`, `autopilot`, `app list`, `app <action> [json]`, `call <tool> [json]` (any tool, raw args), `events` (one line per event until interrupted).

- A message argument of `-` reads stdin: `echo "..." | ompdesk open -`.
- `ompdesk send <session> "..." --wait` sends and returns when the turn ended; `ompdesk wait <session> --until idle|blocked|done|any [--timeout SECONDS]` waits without sending.
- `agent_blocked` means the session waits on the person for an answer or approval. Ask the person first. Never `--force` a message past a person's question without a reason you can state.
- `agent_prompt_stalled`: the session did not start working on the message; check `ompdesk state`.
- `--json` prints the raw result as JSON (`{"ok":false,"error":{...}}` on failure) instead of the tool's text.
- `--caller NAME` (or `OMPDESK_CALLER`) labels the outside caller; it does not authenticate a session.
- Exit codes: 0 ok; 1 failed (tool error, `agent_blocked`, `agent_prompt_stalled`, `timeout`, `session_gone`, `events_lost`); 2 usage; 3 OMPdesk not running or refused.
