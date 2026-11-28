import { defineConfig } from "vitest/config";

// The measurement runner already built exactly the two cores it needs. Don't run the suite's native global setup.
export default defineConfig({ test: { include: ["scripts/item-cost.probe.mjs"], maxWorkers: 1 } });
