# Desktop title bar

## Control placement

The desktop uses one 36 px row. The table specifies the replacement for each control. The paired browser and phone keep their session and destination controls without desktop window controls.

| Previous control or information | Desktop location | Keyboard access |
| --- | --- | --- |
| Brand, collapse sidebar, reopen sidebar | Left end of the row. Windows shows the mark and application menu. macOS keeps the system menu and shows the app name. | Tab to the sidebar toggle, then Space. On Windows, Tab to the menu and press Enter. |
| Command palette | Search row in the sidebar | Palette shortcut, or Tab to the search-row button and press Enter. |
| Back to the session from a destination | Back to session, before the tabs. The history arrows stay on the left. | Escape, or Tab to Back to session and press Enter. |
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

| Reference state | Evidence |
| --- | --- |
| macOS window, dark, sidebar docked | Seen in the [published image](https://github.com/stablyai/orca/blob/0f56430a/docs/assets/readme-hero.jpg). The tabs begin at the sidebar divider. |
| macOS full screen, sidebar collapsed | From source, not seen: [left controls](https://github.com/stablyai/orca/blob/0f56430a/src/renderer/src/app-shell/chrome/TitlebarLeftControls.tsx) and [layout](https://github.com/stablyai/orca/blob/0f56430a/src/renderer/src/app-shell/chrome/use-app-chrome-layout.ts). |
| Windows normal, maximized, full screen; light/dark and English/Korean | From source, not seen: [window options](https://github.com/stablyai/orca/blob/0f56430a/src/main/window/createMainWindow.ts#L143-L160), [dimensions](https://github.com/stablyai/orca/blob/0f56430a/src/renderer/src/app-shell/chrome/app-window-chrome.ts#L18-L24) and [tab strip](https://github.com/stablyai/orca/blob/0f56430a/src/renderer/src/app-shell/chrome/TitlebarMainStrip.tsx). |

The OMPdesk implementation uses its own components, assets and native host. No Orca code or assets are bundled (Orca: MIT, Copyright 2026 Lovecast Inc.).

## Native acceptance

- Windows CI: `e2e/window-chrome-hit.e2e.ts` records the owned HWND's replies. `e2e/window-chrome-actions.e2e.ts` travels the buttons by keyboard, checks actual placement and captures the renderer. `win_e2e_grep=Windows (title bar|caption buttons)` selects both specs and all four language/theme combinations; `@smoke` uses English/light. A green DOM test is not evidence of native input. On the installed app, drag the blank row, double-click it, resize from the top, and hover Maximize until the Windows 11 Snap flyout appears.
- macOS: capture initial placement, resizing, sidebar collapse and native full-screen entry/exit in light and dark, English and Korean. Confirm one set of system lights centered in the 36-point row at default zoom, an 80-point inset only outside full screen, and restored lights at the same position on exit. Test the system buttons, empty-row drag, the user's double-click preference, and no drag over a tab, menu or sheet.
- Paired desktop browser and phone: the existing session controls remain in the page; neither loads `DesktopChrome`. Check the production phone bundle with `scripts/check-main-bundle.ts`; a renderer harness capture does not measure shipped bytes.
