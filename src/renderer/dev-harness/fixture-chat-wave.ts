/**
 * Dev-harness fixture for Wave A Orca chat UI parity captures (`?chatwave=stream` or `?chatwave=visual`):
 * adds a Wave A reply turn (Brain-icon thinking, verified clickable file-line chips, multi-line code block,
 * and an interactive sandboxed `::orca-visual{...}` card backed by `CHAT_WAVE_VISUAL_HTML`).
 */

export const CHAT_WAVE_VISUAL_FILE = "chat-parity-benchmark.html";

/** Self-contained interactive HTML visual using forwarded `--sc-*` / `--chart-*` theme tokens. */
export const CHAT_WAVE_VISUAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body {
    padding: 14px 16px 16px;
    font-family: var(--sc-font-sans, system-ui, sans-serif);
    color: var(--sc-text, #f2f2f2);
    background: transparent;
  }
  .wrap { display: flex; flex-direction: column; gap: 12px; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .title { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; color: var(--sc-text); }
  .sub { font-size: 11px; color: var(--sc-text-muted); margin-top: 2px; }
  .tabs { display: inline-flex; gap: 4px; padding: 2px; border-radius: 7px; border: 1px solid var(--sc-divider); background: var(--sc-code-bg); }
  .tab {
    border: 0; background: transparent; color: var(--sc-text-muted); font: 500 11px/1 var(--sc-font-sans);
    padding: 5px 8px; border-radius: 5px; cursor: pointer;
  }
  .tab[aria-pressed="true"] {
    background: var(--sc-elevated); color: var(--sc-text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.14);
  }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .kpi {
    padding: 9px 11px; border-radius: 8px;
    border: 1px solid var(--sc-divider); background: var(--sc-code-bg);
  }
  .kpi-label { font-size: 11px; color: var(--sc-text-muted); }
  .kpi-val { font: 600 17px/1.25 var(--sc-font-mono); color: var(--sc-text); margin-top: 2px; }
  .kpi-val.ok { color: var(--sc-success); }
  .kpi-val.accent { color: var(--sc-accent); }
  .kpi-note { font-size: 10.5px; color: var(--sc-text-subtle); margin-top: 2px; }
  .chart {
    padding: 11px 12px; border-radius: 8px;
    border: 1px solid var(--sc-divider); background: var(--sc-code-bg);
    display: flex; flex-direction: column; gap: 8px;
  }
  .chart-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--sc-text-muted); }
  .legend { display: inline-flex; gap: 12px; align-items: center; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 99px; margin-right: 5px; vertical-align: middle; }
  .row { display: grid; grid-template-columns: 164px minmax(0, 1fr) 44px; align-items: center; gap: 10px; font-size: 11.5px; }
  .row-name { color: var(--sc-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bars { display: flex; flex-direction: column; gap: 3px; }
  .track { height: 6px; border-radius: 99px; background: var(--sc-surface-2); overflow: hidden; }
  .fill-before { height: 100%; border-radius: 99px; background: var(--sc-text-subtle); opacity: 0.45; }
  .fill-after { height: 100%; border-radius: 99px; background: var(--chart-1, var(--sc-accent)); }
  .fill-after.g { background: var(--chart-2, var(--sc-success)); }
  .pct { text-align: right; font: 500 11px/1 var(--sc-font-mono); color: var(--sc-text); }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div>
      <div class="title">Orca Native-Chat Component Parity · Wave A</div>
      <div class="sub">Before (4d046c604) vs Wave A · theme-synced inside sandbox="allow-scripts"</div>
    </div>
    <div class="tabs" role="group" aria-label="View">
      <button class="tab" type="button" data-view="parity" aria-pressed="true">Parity Score</button>
      <button class="tab" type="button" data-view="budget" aria-pressed="false">Bundle Split</button>
    </div>
  </div>
  <div class="kpis">
    <div class="kpi">
      <div class="kpi-label">First-Screen JS Delta</div>
      <div class="kpi-val ok">~0 KB</div>
      <div class="kpi-note">Visual + quote lazy-chunked</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Iframe Sandbox</div>
      <div class="kpi-val accent">allow-scripts</div>
      <div class="kpi-note">Strict CSP · no network</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Wave A Unit Tests</div>
      <div class="kpi-val">20+</div>
      <div class="kpi-note">Parser, CSP, tools, quotes</div>
    </div>
  </div>
  <div class="chart">
    <div class="chart-head">
      <span id="chart-caption">Component Craft Coverage (Before vs Wave A)</span>
      <span class="legend">
        <span><span class="dot" style="background:var(--sc-text-subtle);opacity:0.55"></span>4d046c604</span>
        <span><span class="dot" style="background:var(--chart-1,var(--sc-accent))"></span>Wave A</span>
      </span>
    </div>
    <div id="rows"></div>
  </div>
</div>
<script>
(function(){
  var DATA = {
    parity: {
      caption: "Component Craft Coverage (Before vs Wave A)",
      items: [
        { name: "Inline Sandboxed Visuals", before: 6, after: 100, cls: "g" },
        { name: "Tool & Diff Row Rhythm", before: 46, after: 96, cls: "" },
        { name: "Code Header & File Chips", before: 52, after: 95, cls: "" },
        { name: "One-Click Selection Quote", before: 58, after: 98, cls: "g" }
      ]
    },
    budget: {
      caption: "Lazy-Loaded Share of Wave A Feature Weight",
      items: [
        { name: "InlineVisualCard + Shell", before: 0, after: 92, cls: "g" },
        { name: "Inert HTML Code Preview", before: 0, after: 100, cls: "g" },
        { name: "SelectionQuotePopover", before: 100, after: 100, cls: "" },
        { name: "Eager Directive Fast-Path", before: 10, after: 8, cls: "" }
      ]
    }
  };
  var rowsEl = document.getElementById("rows");
  var capEl = document.getElementById("chart-caption");
  function render(key) {
    var d = DATA[key] || DATA.parity;
    capEl.textContent = d.caption;
    rowsEl.innerHTML = d.items.map(function(item){
      return '<div class="row">'
        + '<div class="row-name">' + item.name + '</div>'
        + '<div class="bars">'
        + '<div class="track"><div class="fill-before" style="width:' + item.before + '%"></div></div>'
        + '<div class="track"><div class="fill-after ' + item.cls + '" style="width:' + item.after + '%"></div></div>'
        + '</div>'
        + '<div class="pct">' + item.after + '%</div>'
        + '</div>';
    }).join("");
  }
  render("parity");
  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(btn){
    btn.addEventListener("click", function(){
      var key = btn.getAttribute("data-view");
      Array.prototype.forEach.call(document.querySelectorAll(".tab"), function(b){
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
      render(key);
    });
  });
})();
</script>
</body>
</html>`;

export function chatWaveMessages(base: number): Record<string, unknown>[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking:
						'Comparing `src/renderer/components/tools/ToolCard.tsx:76` against Orca\'s single-line tool disclosure.\n\n- Align file path chips and right-side duration/diff metrics\n- Isolate inline visuals in a `sandbox="allow-scripts"` iframe with theme forwarding',
				},
				{
					type: "text",
					text: [
						"Updated the chat stream components in `src/renderer/components/chat/CodeBlock.tsx:109` and `src/renderer/components/tools/ToolCard.tsx:251`.",
						"",
						"```tsx",
						"export function InlineVisualFrame({ html, title }: VisualFrameProps) {",
						'  return <iframe sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={html} title={title} />;',
						"}",
						"```",
						"",
						`::orca-visual{file="${CHAT_WAVE_VISUAL_FILE}" title="Wave A Chat UI Telemetry"}`,
					].join("\n"),
				},
			],
			stopReason: "stop",
			model: "claude-sonnet-5-5",
			provider: "anthropic",
			timestamp: base,
		},
	];
}
