# Shell exit receipt

The model checks ordering across the Node shim, FIFO host reader, lifecycle acceptance, delayed answer, shutdown and Node join. It represents one client, one shell, one optional relaunch, one effective exit, two exit codes and both pre-CEF and CEF paths. It includes a nondeterministic grace timeout and unexpected death. `matrix.json` includes a negative premature-stdin-close variant. `mutations.json` supplies negative controls for the invariants.

Run through the formal manifest's hosted runner after registration. No model-checking result or implementation proof is asserted by these files. See `CORRESPONDENCE.md` for abstractions and excluded races.
