import { config } from "zod/mini";
import english from "zod/v4/locales/en.js";

// Keep classic Zod's validation messages without its schema authoring and JSON Schema exporters on the first screen.
if (!config().localeError) config(english());
export { z } from "zod/mini";
