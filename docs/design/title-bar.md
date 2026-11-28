# Desktop title bar

## Control placement

The desktop uses one 36 px row. The table specifies the replacement for each control. The paired browser and phone keep their session and destination controls without desktop window controls.

| Previous control or information | Desktop location | Keyboard access |
| --- | --- | --- |
| Brand, collapse sidebar, reopen sidebar | Left end of the row. Windows shows the mark and application menu. macOS keeps the system menu and shows the app name. | Tab to the sidebar toggle, then Space. On Windows, Tab to the menu and press Enter. |
| Command palette | Search row in the sidebar | Palette shortcut, or Tab to the search-row button and press Enter. |
| Back to the session from a destination | History arrows on the left; Escape still closes the destination. | Back and forward shortcuts, or Tab to an available arrow and press Enter. |
| Session name and run, attention, or connection state | Active session tab; the accessible label includes the state. | Tab to the tab strip; arrow keys select a tab. A screen reader announces the active tab and its state. |
| Rename and automatic title | Active tab menu, **Rename** | Open the tab menu by keyboard, choose Rename, edit, and press Enter. Tab to the automatic-title button to generate a title. |
| Project picker | Active tab menu | Open the menu, choose the project command, and press Enter. |
| Device, worktree, fork parent, bot home | Active tab details; links stay actionable and identifying text stays readable. | Open the tab menu by keyboard; use the detail actions or read their labels. |
| Branch, session tree, share, tools, import, Insights | Active tab menu | Open the tab menu, use arrow keys to choose the command, and press Enter. |
| Session status, cost, tokens, cache, execution time | Existing desktop status bar; the usage button opens session statistics. | Tab to session statistics, press Enter, then Escape to close. |
| Side panel toggle | Right end of the strip when the panel is closed; the open panel has its own close button. | Panel shortcut, or Tab to the open or close button and press Enter. |
| Minimize, maximize or restore, close | Three 46 px controls at the right on Windows; native traffic lights on macOS. Neither appears in a paired browser. | Windows: Tab to the button and press Space. macOS: native window commands. |

The tab menu must have a focusable trigger and support Shift+F10 on the active tab. The strip must leave a drag target outside buttons when the sidebar is closed and when the tab list overflows.

## Reference

[Orca's pinned title-bar components](https://github.com/stablyai/orca/tree/0f56430a/src/renderer/src/app-shell/chrome) and [published desktop image](https://github.com/stablyai/orca/blob/0f56430a/docs/assets/readme-hero.jpg) describe the target. The image shows the macOS window outside full screen with its sidebar open. Windows hit testing and fullscreen behavior require separate checks; neither is visible in that image.
