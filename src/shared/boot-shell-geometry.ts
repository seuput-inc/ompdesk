/**
 * The numbers the first-paint shell (scripts/boot-shell.ts, written into index.html and web.html) shares with the
 * React layout, in one place so neither drifts: the sidebar's width range and the key its width is mirrored under for
 * pre-paint.js, and the composer box's height.
 */

/** The docked sidebar's width range and its first-run width (Sidebar.tsx drags within it): Orca's 280 in 220–500. */
export const SIDEBAR_WIDTH = { min: 220, max: 500, default: 280 } as const;

/** localStorage mirror of the `sidebarWidth` pref: prefs arrive over IPC, this is readable before the first paint. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "omp.sidebarWidth";

/** localStorage mirror of the `sidebarVisible` pref (`"0"` = collapsed): pre-paint.js reads it to hide the boot shell's sidebar on the first frame. */
export const SIDEBAR_VISIBLE_STORAGE_KEY = "omp.sidebarVisible";

/** The idle composer box: 1px border, the input line and the toolbar (measured against the React box by e2e/no-loading.e2e.ts); the phone's always-open box (the field row over its one controls row) is shorter. */
export const COMPOSER_BOX_PX = { desktop: 92, phone: 81 } as const;
