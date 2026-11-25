# A2UI in OMPdesk

Design for the owner's review, 26 Nov 2026. Unit 1 (the catalog and the bridge tool) is built; the rest is not. Every claim names the file it was read from; what was not checked says so.

**One sentence.** The main agent gets one bridge tool, `a2ui`, that takes A2UI v1.0 messages; OMPdesk draws the surface inline in the transcript with its own shared components, in the window, a paired computer's view and the phone alike, and a button the person presses comes back to the agent as that tool call's result through the ask form's existing blocking channel.

Sources read: the A2UI repository at `a2ui-project/a2ui@92c0ed6` (spec `specification/v1_0/docs/a2ui_protocol.md`, schemas `specification/v1_0/json/*`, basic catalog `catalogs/basic/v1/catalog.json`, `typescript/core/web_core`, `typescript/renderers/react`, `LICENSE`); npm `@a2ui/web_core` and `@a2ui/react` 0.16.1; stock omp 19.2.1 (`modes/rpc/rpc-mode.ts`, `tools/html-form/*`, `extensibility/extensions/types.ts`, `pi-ai/src/utils/schema`); this repo's `AGENTS.md`, `.omp/rules/{ui-parity,composer,panels-sidebar}.md`, `src/renderer/components/common/README.md` and the seams named below.

## 0. What A2UI is, in the parts that matter here

- A one-way stream of JSON envelopes from agent to renderer: `createSurface`, `updateComponents`, `updateDataModel`, `deleteSurface` (plus `callRendererFunction`/`agentFunctionResponse`, which OMPdesk refuses, §4). Each envelope carries `"version": "1.0"`.
- A surface is a flat list of components (adjacency list, `id` references, one `root`) plus a JSON data model. Properties are literals, `{"@path": "/json/pointer"}` bindings or `{"@call": fn, "args"}` calls to functions the **catalog** declares. Input components write to the data model locally; nothing goes to the agent until an `action.event` fires, which sends `{name, surfaceId, sourceComponentId, context, userMessage?}` and, with `sendDataModel`, the whole data model.
- The catalog is the renderer's contract: which components and functions exist, with JSON Schemas. v1.0 dropped `theme`; styling belongs to the host. The spec expects a prompt → generate → validate loop with errors in a fixed shape (`VALIDATION_FAILED`, `surfaceId`, JSON-pointer `path`, one-sentence `message`).
- Transport is not specified; A2UI rides AG-UI, A2A, MCP or anything that delivers in order. Here the transport is an omp tool call.

## 1. How the agent emits A2UI

**Stock omp has no A2UI support** (`grep -ri a2ui` over `@oh-my-pi/*` 19.2.1: no hits) and no generative-UI tool. So this is case 5 of "Where a new feature goes": built inside OMPdesk on omp's public extension API.

### The tool

`resources/gui-bridge/modes/a2ui.ts` registers one tool with `pi.registerTool` (the shape `modes/autopilot.ts:920` uses), feature `a2ui` in `capabilities.ts`:

- **Registered when omp starts**, not at the bridge's first use: `registerA2ui(pi)` runs in `resources/gui-bridge/index.ts`'s factory, before stock builds the session, beside the waste guards' `wait`. A tool added later moves in omp's tool order and rebuilds the prompt, and a turn stock's restore continues runs no `before_agent_start`, so registering from an area hook left a relaunched turn without the tool and with another prompt. The `AREAS` entry `modes/a2ui` only lists the feature for the compatibility check (`methods = guard("a2ui", {})`). Cost at start: §8.
- `name: "a2ui"` (a model that has seen A2UI recognises the name), `loadMode: "essential"`, `approval: "read"`, main agent only: subagents never get it (asserted in `bridge-restore-subagents-stock.test.ts`), and `execute` refuses any agent whose `ctx.agent.kind` is not `main` (subagents have no person looking at their transcript).
- `parameters`: `{ messages: Array<object> }`, deliberately loose so the tool costs few prompt tokens. The description carries the catalog in compact form (each component, its props, the three rules: one `root`, ids are references, `@path` binds; one complete example; when to prefer stock `ask`). Budget about 1,200 tokens, measured with the context inspector in unit 1; over budget, the catalog detail moves to a short `registerPromptSection` text and the tool description keeps the summary.
- No prompt section of its own otherwise: a tool description already rides every request, and `lint-prompt-sections` forbids a hook's own `systemPrompt`.

### What `execute` does

1. **Validate** every envelope before anything is drawn, so the agent learns about a bad payload in the same turn (the spec's generate → validate loop):
   - Schema: A2UI's own `agent_to_renderer.json` + `common_types.json` with `catalog.json` mapped to OMPdesk's catalog (§2), checked by stock's JSON-Schema validator `validateJsonSchemaValue` from `@oh-my-pi/pi-ai` (root export, `utils/schema/json-schema-validator.ts:779`), imported through the omp layer's existing `resources/gui-bridge/omp/pi-ai.ts` (the package root is a bundled module, AGENTS.md › Bridge › Only the running omp's modules, so no `COPY_SAFE` entry and no `HEAVY_COPIES` cost). No validator of our own. That validator resolves **local** refs only (`resolveLocalRef`, line 168; it tracks recursive `$ref` cycles itself), and A2UI's three files `$ref` each other (`common_types.json#/$defs/…`, `catalog.json#/$defs/anyComponent`). So unit 1 ships the vendored files merged into one root schema: every file's `$defs` under one `$defs`, every cross-file ref rewritten to `#/$defs/…`, generated by a script from the pinned package and checked for drift. No `dereferenceJsonSchema` pass: inlining would cut the recursive `DynamicValue`/function-argument refs to `{}` (its documented cycle break) and silently accept anything there.
   - Semantics the schema cannot say (pure `a2ui-core.ts`): exactly one `root` per created surface; every `ComponentId`/`ChildList` reference resolves; no cycles; `createSurface` of an id this session already has is `INTEGRITY_ERROR`; an update names a surface created **earlier in the same turn** (read from `ctx.sessionManager.getBranch()`; see §2 Replay for why); caps (§4).
   - **One `a2ui` call per assistant message.** Stock runs the tool calls of one message side by side, so a second call could not see the surface the first creates, and two calls with buttons would raise two waiting forms. Every `a2ui` call after the first in the same message is refused with `INTEGRITY_ERROR` at `/messages` (`a2uiPriorCalls` marks the earlier ones `sibling`), and the error tells the agent to put every surface message into one call.
   - A failure returns a tool **error** whose text is the spec's error object(s), so the agent self-corrects without the person seeing a broken card.
2. **Display-only** (no component carries `action.event`): return at once, `"Shown to the person."` plus the surface ids. The card draws from the tool call itself.
3. **Interactive**: first make sure someone can press the button (`a2uiUnanswerable` in `a2ui-core.ts`). When stock `ask` is not among the active tools (an unattended run: Autopilot turns `ask` off) or the session has no window (`!ctx.hasUI`, no `formDialog`), the call is refused with a `VALIDATION_FAILED` error at `/messages` telling the agent to show the surface without an event button or decide itself, because the form would wait forever. Otherwise wait for the person through stock's blocking form channel, `await ctx.ui.formDialog(markerForm, {signal})`:
   - `markerForm` is a tiny but valid stock html-form: `<form data-ompdesk-a2ui="<toolCallId>"><p>The agent is waiting for your answer in the form above.</p><textarea name="a2ui_answer"></textarea></form>` (constant and parser in `modes/a2ui-contracts.ts`, shared with the renderer).
   - Stock turns it into the ordinary `extension_ui_request {method: "form", id, html}` (`rpc-mode.ts:1357`) and validates the response against that one textarea (`parseFormDialogResponse`, `html-form/data.ts`). The renderer answers with `{data: {a2ui_answer: <JSON of the action>}}`.
   - The result returned to the agent: one line saying what the person did (`Pressed "Submit" (submit_form) on contact_form`), then the action JSON (`name`, `sourceComponentId`, resolved `context`, `userMessage`, and `dataModel` when the surface asked for `sendDataModel`). `details` carries the same object for the renderer.
   - Cancelled (the card's Skip, Escape on the dock row) → `"The person dismissed the form without acting."`; the turn's Stop aborts through `signal` as for any stock dialog.

### Why the form channel and not a channel of our own

Riding `extension_ui_request {method: "form"}` reuses, unchanged, everything a waiting question already has: the "Needs you" count and work-board attention (`renderer/lib/attention.ts` `pendingAsks` counts every blocking request), the OS notification and phone push, first-answer-wins across windows and the closing of the other views' cards (`crates/core/src/pool/later.rs` `route_side_channel`), the paired host's relay (`remote/host-services.ts` `#answer`), the phone (`EXTENSION_UI_RESPOND` passes in `web/ipc-policy.ts`), and a reloaded page getting the open request (`EXTENSION_UI_OPEN`). A channel of our own would have to rebuild all of it inside `crates/core/src/pool` and `src/main/sidecar-pool.ts`, both off-limits while the Node removal rewrites them.

Version skew degrades gracefully: an older OMPdesk on a paired device does not know the marker, so it draws the marker form as an ordinary ask with one text box; whatever the person types reaches the agent as a free-text answer (`execute` returns non-JSON answers verbatim, labelled as such).

## 2. The renderer

### One engine, our views

- **Engine: `@a2ui/web_core`** (Apache-2.0, exact version pin): `MessageProcessor`, `SurfaceModel`/`DataModel` (JSON Pointer, upsert, two-way binding), `GenericBinder`, the expression parser (`formatString`), checks, the A2UI regex dialect with its safety rules, and the basic functions (`required`, `regex`, `length`, `numeric`, `email`, `format*`, `pluralize`, `and`/`or`/`not`). It is conformance-tested upstream; rewriting it would be thousands of lines of someone else's spec. Its root entry imports no `lit` (`web_core/src/index.ts` exports `processing`, `state`, `resolution`, `expressions`, `catalog`; `lit` appears only under `src/universal/` and the basic catalog's components). **The basic functions are not on the root**: they are exported only from `@a2ui/web_core/v1_0` and `./catalogs/basic/v1`, and both re-export `universal`, which imports `lit`; the `exports` map offers no deeper path. What keeps `lit` out of our chunk is the package's `"sideEffects": false` (npm 0.16.1) letting the bundler drop the unused custom-element modules. That is unit 2's first check (the bundle refusal below). Fallback if it does not hold: a build alias to the pinned package's function files under `dist/src/v1_0/functions/` and `dist/src/catalogs/basic/v1/functions/`, kept honest by the exact pin; last resort, accept `lit` inside the lazy chunk only, with its size stated.
- **Not `@a2ui/react`.** Its root imports `@a2ui/web_core/universal` (`catalog/react_host_element.ts`), so `lit` and `markdown-it` come along, and it wraps every node in an `<a2ui-react-*>` custom element that writes its own ARIA (`host_accessibility.ts`). OMPdesk's kit already owns names, roles and focus (`components/common/README.md` › Rules), so a second layer writing ARIA over ours is a bug source. Our adapter is about a hundred lines: a `useSyncExternalStore` hook over web_core's signals and a `NodeView` that looks the component type up in our catalog.
- web_core declares `zod ^3.25`; the repo is on zod 4, so bun installs a nested zod 3 for it. Acceptable inside a lazy chunk; unit 2 measures the chunk.

### OMPdesk's catalog

One JSON file in A2UI's catalog format, `resources/gui-bridge/modes/a2ui-catalog.json` (catalogId `https://github.com/seuput-inc/ompdesk/a2ui/v1`, a name we own; a catalogId need not resolve). It lives in the bridge because contracts the renderer shares live in `resources/gui-bridge/`. The bridge validates against it; the renderer builds the web_core `Catalog` from it (`JsonComponentApi`). One file, two readers, no copy.

It starts from the basic catalog (component names and props unchanged where kept, so a model trained on A2UI writes valid payloads) and maps each onto `components/common`:

| A2UI component | OMPdesk draws | Notes |
| --- | --- | --- |
| `Text` | `MarkdownRenderer` (sanitized, model text) | `variant` h1–h5/caption/body → the kit's type scale |
| `Image` | `ZoomableImage` via `classifyImageSrc` | `url` must be a literal (§4) |
| `Icon` | a fixed name → lucide map | unknown name draws nothing and is reported |
| `Row`, `Column`, `List` | flex/grid `div` on spacing tokens | `List` is `role="list"`, max 200 children |
| `Card` | `Card` | |
| `Tabs` | `Tabs` (`underline`) | |
| `Modal` | `Modal` opened by a `Button` | never a dialog from a dialog (container policy) |
| `Divider` | a token-coloured rule | |
| `Button` | `Button` | `primary` → primary (one per surface; extras drawn secondary), `borderless` → ghost, default → secondary |
| `CheckBox` | `Checkbox` | |
| `TextField` | `Input` / `TextArea` (`longText`) / `Input type=number` | no `obscured` variant (§4); errors through `FieldShell` |
| `DateTimeInput` | `Input` of type `date`/`time`/`datetime-local` | |
| `ChoicePicker` | single: `Radio` group, or `Select` past 15 options; multiple: `Checkbox` group; `displayStyle: chips` → `Chip` toggles | `FieldLabel` names the group |
| `Slider` | **new** `components/common/Slider` | the kit has no range control; added per the README's rules (catalog row, styleguide sample, linkedom test) |
| `Chart` (OMPdesk's own) | chart.js through `lib/chart.ts` | `kind` bar/line/doughnut, `labels`, `series` bound to the data model; replaces upstream's `VegaChart` (§3) |
| `Video`, `AudioPlayer` | not in the catalog | no use worth the egress (§4); an agent that sends one gets a validation error |

Functions: the basic set above. `openUrl` stays (it needs a user gesture by spec) and goes through `lib/open-external.ts`, http(s) only. No agent-side functions: the processor is set up so an unknown `@call` is an error, never a `callAgentFunction` (the spec allows a renderer to reject functions its catalogs do not name; which web_core option does that is unit 2's first case).

### Where it draws, on every surface

- **The call's own row in the chat** (decided in unit 3 with the owner's coordinator, 26 Nov 2026): a REGISTRY body alone draws only in `ToolCard`'s folded body inside the work card, closed by default, so a surface would be hidden and an interactive one would wait on the person unseen. Like the reply's text (work-board.md › "What a reply says to the person … stay in the chat"), `buildHistoryRows` (`chat/chat-stream-utils.ts`) cuts every `a2ui` call out of its message into a message row of its own (`inRun`), under the card holding the message's other steps and under its text; the card keeps no step of it, and a message holding only views opens no card. `MessageBubble` draws an `a2ui` call block as `A2uiChatCard` (`tools/index.tsx`), never a folded `ToolCard`. This row is the only one that may answer.
- The REGISTRY entry (`a2ui` → `A2uiChatCard` without `live`) stays for the step body that still exists while the arguments stream (the live card's step, `LiveStepPeek`): it draws the same surfaces **inert**, never a second answerable copy. Both load `tools/renderers/A2uiRenderer.tsx` with `lazyChunk` as `AgentDesktopRenderer` is, so the phone's first-screen budget does not grow; while the chunk loads, a `Skeleton` in the card's place (no-loading-screens rule).
- Window, paired computer and phone run the same React bundle on the same transcript events (`remote-sidecar.ts` re-emits the host's; the phone's `web/shim.ts` swaps only the transport). So there is one renderer and no device branch. The parity sheet gets two surfaces (unit 3, unit 4).

### Streaming and replay

- **The transcript is the only state.** A session's surfaces are the fold of its `a2ui` tool calls' `messages`, in transcript order, through one `MessageProcessor` per session, plus each answered call's `details.dataModel` applied on top (so after a reload the card shows what was submitted). No store in main, nothing in the core, nothing new to sync: every view rebuilds the same surfaces from the same events.
- **Streaming**: while the call streams (`ToolRendererProps.isPartial`, arguments parsed as they arrive), every complete element of `messages` is applied once (a per-call applied count); the trailing incomplete element waits. A2UI's progressive rendering (render from `root` as soon as it exists, placeholders for missing children) does the rest.
- **Updates across calls**: allowed only within the same turn (the bridge refuses others). The surface draws in the newest card that touched it; an earlier card of it shrinks to one line, "Updated below". Same turn keeps the creating call within the loaded transcript in practice; if older history is not loaded, the card says so with the transcript's own "load earlier" action instead of drawing a half state.
- **Interactive state**: a card is live only while its call has a pending marker form (found by `data-ompdesk-a2ui="<toolCallId>"` in the request's `html`). Without one, inputs are disabled and buttons inert; after an answer the pressed button keeps a ✓ and the line "You sent: …".

### Actions back to the agent

1. The person presses a `Button` whose `action.event` is set. The binder resolves `context` (and the data model if `sendDataModel`).
2. `A2uiRenderer` sends `{type: "extension_ui_response", id, data: {a2ui_answer: JSON}}` through the existing responder (`hooks/use-extension-ui.ts`), the same call `ExtensionDialog` makes for an ask. From this computer's window it goes `EXTENSION_UI_RESPOND` → `routeSideChannel`; from a paired computer's view of a host's tab, over the link to the host's `host-services.ts` `#answer`; from the phone, the same IPC channel over the WebSocket (`mode: "pass"`). The request id is stock's Snowflake, new per call, so the shared-id race the ask parity surface once hit (ui-parity.md, `card-ask-pictures`) cannot reuse an answer across calls.
3. The core's first-answer rule closes the other views' pending request; their cards go inert when the tool result arrives.
4. `ExtensionDialog`'s `form` case skips a marker form: instead of an ask card the dock shows one row, "The agent is waiting for your answer above", with a jump to the card (phones scroll; the person may be far from it) and Skip.
5. Checks (`required`, `email`, …) gate the button: `isValid === false` disables it with `disabledReason` naming the first error, and each field shows its errors through `FieldShell`.

## 3. Relation to the ask form and Preview visuals

| | Stock `ask` + OMPdesk's ask card | `a2ui` | `gui_visualize` (Preview) |
| --- | --- | --- | --- |
| What | one or a few questions, stock html-form | a laid-out form, confirmation with details, chart, small dashboard | any page, SVG or image the agent writes |
| Where | the dock above the composer | inline in the transcript | Preview panel, local tabs only |
| Drawn by | kit (`AskDialog`), page never mounts the HTML | kit, from a fixed catalog | the agent's own HTML in a sandboxed page |
| Answer | `extension_ui_response` | the same channel | `choose`: a trusted `data-choice` click, max 600 s |
| Paired computer / phone | yes | yes | no (refused for a host's tab) |

- **Ask: coexist, share the channel.** `ask` is stock's tool with stock's semantics; the agent keeps it for a quick question. Replacing it would mean overriding a stock tool for no gain. `a2ui` borrows its transport (§1) and the same kit primitives (`Radio`, `Checkbox`, `Input`); the ask card's `ChoiceList` is not reused, because A2UI's `ChoicePicker` writes to a data model instead of answering at once.
- **Preview visuals: coexist, no bridge.** A visual is free-form HTML in a locked-down page; A2UI is a closed catalog that looks like the app and works on every device. The tool descriptions say which to pick: `a2ui` when the person should answer or the result should look like OMPdesk; `gui_visualize` when the agent needs drawing the catalog cannot do. The inline ` ```svg ` fence stays for static diagrams.
- **Charts**: upstream's `VegaChart` catalog was considered and rejected: Vega's bundle size, a spec language that can load data from URLs, and chart.js is already a dependency (`stats/*Route.tsx`, `lib/chart.ts`).

## 4. Security

The agent's output is untrusted input (prompt injection reaches it). The rules, each enforced in code, not in the prompt:

1. **No code.** Nothing the agent sends is HTML, script, CSS or a function body. Components are the catalog's; an unknown type is a validation error in the bridge and a one-line "Unsupported component" placeholder in the renderer, never an element by that name.
2. **No agent-invoked functions.** `callRendererFunction` is refused by the bridge and ignored by the renderer; the catalog declares no `agentOnly`/`rendererOrAgent` function, and the processor never emits `callAgentFunction`.
3. **Only a user gesture acts.** A button fires only from the kit control's real click/key, and only while the call's marker form is pending; `openUrl` needs that gesture by spec and opens http(s) through `lib/open-external.ts`. Nothing navigates the app, opens a file or runs a command.
4. **No exfiltration through the surface.** `Image.url` is a literal string in OMPdesk's catalog (not `DynamicString`), so typed input cannot be spelled into a URL before the person sends it; it then follows the reply pictures' rule (`classifyImageSrc`). No video or audio. `Text` is sanitized Markdown (`MarkdownRenderer`), whose links open only on click through the link menu.
5. **What leaves the device is what the person sent.** Typing stays in the renderer's data model; only an action sends `context` (and the data model if the surface asked), only to this session's agent. The answer is stored in the session file like any tool result and synced to paired views, so the catalog has no password field and the description tells the agent never to ask for a secret here.
6. **Bounded.** Per call: ≤ 256 KB of messages, ≤ 200 components per surface, depth ≤ 20, data model ≤ 256 KB; answer ≤ 64 KB (under stock's RPC frame limit); regexes through web_core's dialect and safety check (no backreferences, no nested unbounded quantifiers, ≤ 256 code points), `formatString` through its parser's length caps. Over a cap: a validation error to the agent.
7. **Shared first-answer and per-device rules** are the ask channel's, already tested; no new race (no new state machine, so no formal-verification unit).

## 5. Units

Each ends in a check; none touches `src/main/hub.ts`, `src/main/sidecar-pool.ts`, `src/main/index.ts` or `crates/core/src/{pool,prefs,tools}`. The emitter is in `resources/gui-bridge`, the renderer in `src/renderer`.

| # | Unit | Files | Acceptance | Tests |
| --- | --- | --- | --- | --- |
| 1 | Catalog and bridge tool | `resources/gui-bridge/modes/{a2ui.ts,a2ui-core.ts,a2ui-contracts.ts,a2ui-catalog.json}`, vendored A2UI schemas under `modes/a2ui-schema/`, `capabilities.ts` (`a2ui`: `pi.registerTool`, `ui.formDialog`, pi-ai `validateJsonSchemaValue`), bridge `index.ts` `AREAS`, `scripts/omp-boundary/touchpoints.ts` | Main agent sees `a2ui`, subagents do not; tool description ≤ ~1,200 tokens in the context inspector; an invalid payload returns the spec's error with the failing path; display-only returns at once; an interactive one raises one `form` request carrying the marker and returns the answer JSON; Skip and Stop end it as described | `bridge-a2ui-stock.test.ts` (real stock: registration, marker form parsed and answered through stock's `parseFormDialogResponse`, cancel, abort); `a2ui-core.test.ts` driven by upstream's own `specification/v1_0/test/cases/*.json` plus our caps and the same-turn rule; a drift test that the vendored schemas equal the pinned `@a2ui/web_core`'s copies |
| 2 | Renderer engine | `package.json` (`@a2ui/web_core`, exact pin), `src/renderer/lib/a2ui/{session.ts,catalog.ts,use-signal.ts}` | A fixture transcript folds into the expected surfaces; streamed partial arguments apply only complete envelopes and once; a reload rebuilds the same state including submitted values; unknown function or component never leaves the renderer; the a2ui chunk is not in the first-screen budget and contains no `lit` (`scripts/check-main-bundle.ts` refuses it, as it refuses axe-core) | `lib/a2ui/session.test.ts`, `catalog.test.ts` (each security rule of §4 as a case) |
| 3 | Components and the display card | `tools/renderers/A2uiRenderer.tsx`, `tools/index.tsx` `REGISTRY`, `lib/a2ui/views/*`, new `components/common/Slider.tsx` (+ README row, `index.ts`, styleguide sample), a `Chart` view on `lib/chart.ts` | Every catalog component draws with the kit and its names/roles; `lint-surfaces` (controls, IME, locale) clean; en/ko strings; parity sheet `reply-a2ui` (a display surface with a chart) passes in all three views and `--both-orders` | linkedom tests per view (roles, names, keyboard, two-way binding, checks), `Slider.test.tsx`, `catalog.test.ts` row; fake omp `fixture a2ui show` turn in `e2e/fixture/rpc-ui.ts` |
| 4 | Answer path | `A2uiRenderer.tsx`, `dialogs/ExtensionDialog.tsx` (marker form → dock row), `locales/{en,ko}.ts` | Pressing a button answers from the window, a paired computer and the phone; the first answer wins and the other views go inert; "Needs you" and the notification show while waiting; checks block an invalid submit; an older client's text answer reaches the agent; parity sheet `card-a2ui-form` | `A2uiRenderer.test.tsx`, an `ExtensionDialog.test.tsx` case, `e2e/a2ui.e2e.ts` (fake omp `fixture a2ui form`; window, paired, phone) |
| 5 | Rule and notices | new area rule `.omp/rules/a2ui.md` with globs and its line in `AGENTS.md`'s list; `THIRD_PARTY_NOTICES.txt` (`bun run gen:licenses`); `LICENSES/` entry for the vendored files | `bun run licenses:check` green; `agents-md.test.ts` green | the checks themselves |

Units 1 and 2 can run in parallel (the catalog JSON is unit 1's first commit); 3 needs 2; 4 needs 1 and 3; 5 lands with 4.

## 6. License and attribution

- A2UI (spec, schemas, catalogs, `@a2ui/web_core`, `@a2ui/react`) is **Apache-2.0**, copyright Google LLC (`LICENSE` at the repo root, file headers; no `NOTICE` file in the repository). Compatible with OMPdesk's Apache-2.0.
- `@a2ui/web_core` as a production dependency: covered by the generated `THIRD_PARTY_NOTICES.txt` (its nested `zod` 3, `@preact/signals-core`, `zod-to-json-schema`, `validate-color`, `lit`, `@lit/context` are listed by the same script, whether or not the chunk imports them).
- Vendored files (the v1.0 JSON schemas in the bridge, the test cases used as fixtures, and `a2ui-catalog.json` as a derivative of `catalogs/basic/v1/catalog.json`): keep Google's copyright line, add "Modified by SeuPut" where changed (Apache-2.0 §4b), list them in the generator's vendored-code section and put the license text in `LICENSES/`.
- "A2UI" is used only to name the protocol; no logo, nothing implying endorsement (root `NOTICE` already covers our own mark).

## 7. Considered and rejected

| Option | Why not |
| --- | --- |
| A ` ```a2ui ` fence in the reply (`markdown.tsx` `Pre` already branches on `mermaid`/`svg`) | No way back to the agent, no validation loop, and fences draw only after streaming ends (`markdown.tsx` keeps them as code while streaming). Could later carry display-only surfaces; not needed now. |
| A host tool in main like `gui_visualize` | Host tool results are text only (`ipc.ts` `textToolResult`), it is refused on a paired host's tab, and the waiting state would live in main. |
| A bridge promise answered by a new bridge method | Loses the ask channel's attention, notification, first-answer and paired relay, or rebuilds them in the core pool, which is off-limits. |
| `@a2ui/react` | Custom-element host per node with its own ARIA, pulls `lit` and `markdown-it` (§2). |
| Our own A2UI engine | Re-implements web_core's binder, expressions, checks and regex safety; a second implementation of a conformance-tested library. |
| Replace stock `ask` | Stock owns it; the agent keeps the lighter tool for a quick question. |
| Upstream `VegaChart` | Bundle size, URL data loading; chart.js is already here. |

## 8. Risks and what is not checked

- Checked in unit 1: `formDialog` from inside a tool's `execute` works on stock 19.2.1 (`src/main/bridge-a2ui-stock.test.ts`). It raises one `form` request with the marker, and an answer, a dismissal or Stop each end the call. Stock prints the call's `tool_execution_start` after the request it raised, and a thrown error's result carries `details: {}`.
- Checked in the unit 1 follow-up: an event button is refused, not left waiting, when `ask` is off or the session has no window (`a2uiUnanswerable`, `src/main/bridge-a2ui.test.ts`); the stock test does not start an unattended run.
- Measured for unit 1: registering the tool at omp start costs about **2 ms** (stock omp 19.2.1, macOS arm64, `PI_DEBUG_STARTUP=1`, 7 starts with a timer around `index.ts`'s `import("./modes/a2ui")` and `registerA2ui`): importing the module with its catalog and merged schema 1.5–1.8 ms, building the description and `registerTool` 0.25 ms; with Bun's transpiler cache off (`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, as a session's omp runs on Windows) 2.3–2.8 ms. That is under 1% of the time to `ready` (505–555 ms) and about 4% of the 54–65 ms stock's `loadExtensions` phase spends on the whole bridge factory, so the description stays in `a2ui-core.ts` (the split threshold was 15 ms).
- The notification text for a marker form comes from its `<p>`; how `notify-triage.ts` titles a form was not read. Unit 4 checks the line the person sees.
- Whether partial tool arguments reach `ToolRendererProps` as parsed objects for a bridge-registered tool (not only stock's) was not traced; if they arrive only at the end, the card renders when the call completes and progressive rendering waits for that fix.
- `lit` staying out of the renderer chunk rests on tree-shaking under `"sideEffects": false` (§2), not on an import path free of it; not built yet. Unit 2's bundle refusal proves it or triggers the fallback.
- Checked in unit 1: the stock validator terminates on A2UI's recursive refs. Alone it disagrees with 20 of A2UI's 106 agent-to-renderer test cases: it treats `unevaluatedProperties` as permissive, compiles `\p{…}` without the `u` flag and skips `format: uri`. With `a2ui-core.ts`'s own checks of property keys, identifiers and URLs, all 106 agree (`src/main/fixtures/a2ui-spec-cases.json`).
- Models trained on A2UI v0.8 write `surfaceUpdate`/`beginRendering`; the validator rejects them with a pointed message and the description's example is v1.0. Watch the first sessions' error rate.
- web_core is 0.x and moves weekly (0.16.1 published 23 Nov 2026); the exact pin and the schema drift test keep an update deliberate.
