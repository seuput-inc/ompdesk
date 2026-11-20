# ai-memory inside OMPdesk

This directory is [ai-memory](https://github.com/akitaonrails/ai-memory) (MIT, Copyright (c) 2026 Fabio Akita; the
upstream `LICENSE` is kept unchanged), vendored into OMPdesk and built by OMPdesk's own pipeline (`bun run build:memory`).
It is OMPdesk's source from now on: edit it like the rest of the repository.

- Upstream base: tag **v3.4.7**, commit `fa0ec25dbe987b7574a7487ecf92f0873040c2f2`, merged with `git subtree pull --squash`.
- Removed on import (not needed to build or run the binary): `.github/`, `companions/`, `docker/`, `nix/`, `flake.*`,
  the upstream `AGENTS.md` / `CLAUDE.md` (they would be read as instructions for OMPdesk's own work).
- OMPdesk's changes against the tag are the commits that touch this directory after the import (`git log -- native/memory`).
- Merging a newer upstream tag: see "Memory (ai-memory)" in the repository's AGENTS.md (`git subtree pull --squash`),
  then update the tag and commit above and `ompdesk.json`.
