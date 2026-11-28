# What the account usage panel can show (#50)

The desktop status-bar popover and the phone sidebar read the same account reports. A **window** is a quota with a measurable used share. **Credits** are a separate figure on the account that owns the balance or monthly allowance. A window measured in credits or dollars is not necessarily money left to spend. **Not shown** means neither a bar nor a credit figure, not that the provider is unsupported elsewhere.

The inventory is pinned to stock **19.2.0**, the app's [tested version](../src/shared/omp-tested.json). The [pi-ai registry](https://unpkg.com/@oh-my-pi/pi-ai@19.2.0/src/usage/registry.ts) lists 22 default registrations, including separate Ollama registrations. In the [coding agent](https://unpkg.com/@oh-my-pi/pi-coding-agent@19.2.0/src/config/model-registry.ts), `#syncLiteLLMUsage` registers LiteLLM separately. Its aliases reuse that reader. Evidence paths below are relative to `pi-ai/src/usage/`.

| Stock reader | Panel can show | Evidence in the stock reader |
| --- | --- | --- |
| alibaba-token-plan | Windows | `alibaba-token-plan.ts`: 5-hour, 7-day and monthly credit utilization percentages. |
| openai-codex | Windows + credits | `openai-codex.ts`: primary, secondary and model-specific windows; the fetched report's raw `credits` block distinguishes a balance from unlimited. |
| kimi-code | Windows | `kimi.ts`: measured usage rows and reset windows, including a 7-day summary. |
| minimax-code | Windows | `minimax-code.ts`: per-model interval utilization and reset. |
| muse-code | Windows | `muse-code.ts`: rolling-window and weekly percentages. |
| google-antigravity | Windows | `google-antigravity.ts`: model quota buckets and reset windows; an amount without a measurable fraction is not a bar. |
| ollama | Not shown | `ollama.ts`: `ollamaUsageProvider` returns an empty limit list and an explanatory note. |
| factory-droid | Windows + credits | `factory-droid.ts`: pool consumption windows and a distinct USD `extra-balance` limit. |
| ollama-cloud | Not shown | `ollama.ts`: `ollamaCloudUsageProvider` uses the same empty-limit report. |
| anthropic | Windows + credits | `claude.ts`: 5-hour, 7-day and model-specific limits; capped monthly extra usage has USD remaining. |
| cline-pass | Windows | `cline-pass.ts`: 5-hour, weekly and monthly utilization. |
| zai | Windows | `zai.ts`: token, request and credit quotas with windows; none is a separate balance. |
| umans | Windows | `umans.ts`: rolling request usage, soft cap and burst ceiling. |
| opencode-go | Windows | `opencode-go.ts`: 5-hour, weekly and monthly limit descriptors. |
| github-copilot | Windows | `github-copilot.ts`: monthly premium requests or AI-credit allowance; overage requests do not report a prepaid balance. |
| cursor | Windows + credits | `cursor.ts`: included usage and prepaid usage use distinct windows; only the prepaid individual API rail contributes the separate balance. |
| synthetic | Windows | `synthetic.ts`: 7-day regenerating credit quota measured as a percentage. |
| xai-oauth | Windows | `xai-oauth.ts`: weekly credits and product windows, plus monthly included usage; these are quotas. |
| devin | Windows + credits | `devin.ts`: quota percentages and plan-period buckets; `overageBalanceUsd` is separate from those buckets. |
| charm-hyper | Credits | `charm-hyper.ts`: credit balance with a remaining amount but no quota window. |
| commandcode | Windows + credits | `commandcode.ts`: 5-hour and weekly limits; a separate balance sums monthly, purchased and free credits. |
| kiro | Windows | `kiro.ts`: monthly usage, bonus and add-on limits. The credit unit does not itself make these limits a separate balance. |
| LiteLLM | Windows | `litellm.ts`: `budgetLimit` compares spend with the key or user budget; a USD cap is not a prepaid balance. |

These are possible outcomes, not a claim that all plans return every field. [The bridge](../resources/gui-bridge/account-credits.ts) recognizes a positive balance, a monthly cap with a positive remainder, or an explicit unlimited Codex balance. [The sidebar](../src/renderer/components/layout/sidebar/usage-groups.ts) omits accounts with neither a measured limit nor recognized credits. In particular, an empty, missing or zero balance does not become a credit badge. OpenRouter has no stock usage reader in this inventory.

[The capture scenario](../e2e/shipped-credits.e2e.ts) uses two synthetic accounts with the same two windows. Only one has monthly extra usage left. It compares the window edges on each surface; on v0.152.0 the same accounts and windows appear without the separate credit figure. It does not contact any provider or exercise 23 live accounts.
