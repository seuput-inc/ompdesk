# pstack engineering playbooks (OMPdesk built-in)

This folder is a translated copy of [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (MIT, see `UPSTREAM-LICENSE`), pinned in `pstack-config.json`. OMPdesk loads it as an omp extension root while Settings › Agent behavior › pstack engineering mode is on.

Changes from upstream: Cursor and Claude tool, agent and model names are replaced by omp and OMPdesk ones; `tdd` and `teach` are named `pstack-tdd` and `pstack-teach`; the Cursor-only parts (`setup-pstack`, `poteto-help`, `make-bot-ui`, Bugbot triage, the `orchestrate` playbook and the `watch-pr` and `orch` tools) are left out.

OMPdesk keeps three parts of its translation of [pstack 0.15.36](https://github.com/cursor/plugins/tree/c742dd61706fbacc1b95f1a20b7b988cf096ce6c/pstack) across bumps:

- `skills/why/` sends one investigator to each available evidence source, then gives the results to a synthesizer. Its `references/` supplies the prompts, source-specific search instructions, and confidence criteria those agents read.
- `skills/reflect/` sends the transcript to judgment, tooling, and divergent reviewers. Their prompt templates and the synthesizer's acceptance criteria live in `references/`.
- `adapter.md` keeps each playbook's translated description and `skill://` path. The prompt builder checks those routes against the current upstream list and the shipped files. Upstream's shorter list names the playbooks but does not say when to pick each one.

`bun run sync:pstack` preserves both skill directories, including their `SKILL.md` entry points. Keeping only their names or old links would leave agents without the instructions for their tasks. OMPdesk also owns `adapter.md`, `agents/pstack-agent.md`, `pstack-config.json`, and this README. The sync generates the other pack files and records checksums in `pstack-manifest.json`. Do not edit generated files. There is no `plugin.json` because omp would treat the folder as an Agent Plugins root and drop most skills for unknown frontmatter fields.
