---
description: "OMPdesk rules: A2UI generative UI: the bridge's a2ui tool, its catalog and schema, the renderer's engine over @a2ui/web_core, the views on the kit, the card's own chat row, the answer path through stock's form channel, security caps. Read before changing these files."
globs:
  - "resources/gui-bridge/modes/a2ui*"
  - "scripts/gen-a2ui-schema.ts"
  - "src/renderer/lib/a2ui/**"
  - "src/renderer/components/tools/renderers/A2uiRenderer*"
  - "src/main/bridge-a2ui*"
---
## A2UI

The design record is `docs/design/a2ui.md`; this file holds the rules a change must keep.

### One catalog, two readers
- `resources/gui-bridge/modes/a2ui-catalog.json` (catalogId `https://github.com/seuput-inc/ompdesk/a2ui/v1`) is the only catalog. The bridge validates against `a2ui-schema.json`, which `scripts/gen-a2ui-schema.ts` generates from it and the pinned `@a2ui/web_core`'s v1.0 schemas (never edit the schema by hand; a drift test regenerates it). The renderer builds web_core's `Catalog` from the same JSON (`lib/a2ui/catalog.ts`).
- A component in the catalog has a view in `lib/a2ui/views/NodeView.tsx` `A2UI_VIEWS`, and only those (`catalog.test.ts` pins the two sets equal). A type the catalog does not draw is one muted "Unsupported component" line, never an element by that name.
- Every function the catalog declares is one web_core implements (`createA2uiCatalog` throws otherwise). The processor has no `outboundListener`, so no function ever routes to the agent. `openUrl` opens http(s) only, through `openExternal`.
- `@a2ui/web_core` is pinned exactly; an update is deliberate (schema drift test, `lit` refusal below).

### The bridge tool (`modes/a2ui.ts`, `a2ui-core.ts`, `a2ui-contracts.ts`)
- Main agent only. A refused payload is a returned error result with `details.errors` (the spec's error objects); a Stop is a thrown error. Display-only returns `{shown}`; an interactive call waits on stock's form channel with `a2uiMarkerForm(toolCallId)` and returns `{action}`, `{dismissed: true}` or, from an OMPdesk that drew the marker as a plain ask, `{text}`.
- Surface ids are unique per session; an update names a surface created earlier in the same turn. Caps (§4 of the design): messages ≤ 256 KB, ≤ 200 components a surface, depth ≤ 20, data model ≤ 256 KB, answer ≤ `A2UI_ANSWER_MAX_CHARS`.
- `Image.url` is a literal; there is no password field; no Video or AudioPlayer.

### The renderer
- **The transcript is the only state.** `lib/a2ui/session.ts` folds a session's `a2ui` calls in transcript order (plus each answer's `dataModel` re-applied) through one web_core `MessageProcessor`; `sync` applies only what is new and rebuilds on anything else. Calls are keyed by the tools store's entry key (`toolEntryKey`), never a numbering of their own. A refused call is dropped from the fold.
- **Where it draws**: `buildHistoryRows` cuts every `a2ui` call into a chat row of its own under the work card (work-board.md › What a reply says to the person). `MessageBubble` draws it as `A2uiChatCard live`, the only copy that may answer; the REGISTRY's step body (`A2uiChatCard` without `live`) draws it inert.
- **Answer path**: the live card answers only while its call's marker form is pending in that view and the call has no result. A Button's action answers through `useExtensionUiResponder` (first answer wins; paired computers and the phone answer the same way). `ExtensionDialog` draws a marker form as one dock row (`A2uiWaiting`: Show it, Skip), never an ask card.
- **Bundle**: the engine, views and the dock row live in the lazy `A2uiRenderer` chunk; the phone's first screen carries only the row placement and one loader. `scripts/check-main-bundle.ts` refuses `lit` in any renderer asset and fails when no asset carries web_core (so the refusal saw the chunk).

### Pinned by
`lib/a2ui/{session,catalog}.test.ts`, `lib/a2ui/views/views.test.tsx`, `tools/renderers/A2uiRenderer.test.tsx`, the a2ui case of `ExtensionDialog.test.tsx`, "draws an a2ui view in the chat" in `ChatStream.test.tsx`, `src/main/bridge-a2ui{,-stock}.test.ts`, `e2e/a2ui.e2e.ts`; parity surfaces `reply-a2ui` and `card-a2ui-form`.
