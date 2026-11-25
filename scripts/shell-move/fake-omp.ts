// bun fake-omp.ts <dir>: install the e2e suite's fake omp (e2e/sidecar-fixture.ts, as `fixtureOmp` shapes it) under <dir>, write its
// path to <dir>/bin.txt, then stay alive. The fake ends within 2 s of the process that wrote it (`DIES_WITH_TEST`,
// src/main/test-fake-omp.ts), so move-mac.sh keeps this process running for the whole move and kills it at the end.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureOmp } from "../../e2e/harness";

const dir = process.argv[2];
if (!dir) throw new Error("fake-omp.ts needs a directory");
mkdirSync(dir, { recursive: true });
const bin = await fixtureOmp(dir);
writeFileSync(join(dir, "bin.txt.tmp"), bin);
renameSync(join(dir, "bin.txt.tmp"), join(dir, "bin.txt"));
setInterval(() => undefined, 60_000);
