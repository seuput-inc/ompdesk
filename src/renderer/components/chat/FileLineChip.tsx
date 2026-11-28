/**
 * Clickable file-and-line reference chip (Orca's file-line chip parity): shows a subtle
 * file icon, compact basename, optional `:line` (or `:start-end`) badge, full path in the
 * tooltip, and opens the file at that line on click (plus right-click link menu).
 */

import { FileCode2 } from "lucide-react";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useLinkMenu } from "../../lib/link-menu";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { LinkButton, Tooltip } from "../common";

export interface ParsedFileLineRef {
	path: string;
	line?: number;
	endLine?: number;
}

const FILE_LINE_REF_RE = /^(.+?):(\d+)(?:-(\d+))?(?::\d+)?$/;
const HASH_LINE_REF_RE = /^(.+?)#L(\d+)(?:-L?(\d+))?$/;

/** Parse `src/a.ts:42`, `src/a.ts:42-50`, `src/a.ts:42:7`, or `src/a.ts#L42` into path + line range. */
export function parseFileLineRef(raw: string): ParsedFileLineRef {
	const trimmed = raw.trim();
	const hash = HASH_LINE_REF_RE.exec(trimmed);
	if (hash?.[1] && hash[2]) {
		const line = Number(hash[2]);
		const endLine = hash[3] ? Number(hash[3]) : undefined;
		return { path: hash[1], line, ...(endLine && endLine >= line ? { endLine } : {}) };
	}
	const colon = FILE_LINE_REF_RE.exec(trimmed);
	// Avoid misreading a bare Windows drive prefix (`C:\...`) as a line number.
	if (colon?.[1] && colon[2] && !/^[A-Za-z]$/.test(colon[1])) {
		const line = Number(colon[2]);
		const endLine = colon[3] ? Number(colon[3]) : undefined;
		return { path: colon[1], line, ...(endLine && endLine >= line ? { endLine } : {}) };
	}
	return { path: trimmed };
}

export interface FileLineChipProps {
	/** File path, optionally carrying `:line` or `#Lline`. */
	path: string;
	/** Explicit line override (takes precedence over any suffix in `path`). */
	line?: number;
	/** Optional end line for a range badge (`:12-20`). */
	endLine?: number;
	/** Visible label override (defaults to `basename(path)`). */
	label?: string;
	/** Open in the in-app Files viewer at the line (default) or the OS default editor. */
	opensIn?: "viewer" | "native";
	className?: string;
}

export function FileLineChip({
	path,
	line: explicitLine,
	endLine: explicitEndLine,
	label,
	opensIn = "viewer",
	className,
}: FileLineChipProps) {
	const t = useT();
	const tabId = useRuntimeTabId();
	const linkMenu = useLinkMenu(tabId);
	const parsed = parseFileLineRef(path);
	const resolvedPath = parsed.path;
	const line = explicitLine ?? parsed.line;
	const endLine = explicitEndLine ?? parsed.endLine;

	if (!resolvedPath) return null;

	const displayName = label ?? (basename(resolvedPath) || resolvedPath);
	const lineSuffix =
		line !== undefined ? (endLine !== undefined && endLine > line ? `:${line}-${endLine}` : `:${line}`) : "";
	const fullTitle = `${resolvedPath}${lineSuffix}`;

	const handleOpen = () => {
		if (opensIn === "native" && typeof window !== "undefined" && window.omp?.system?.openPath) {
			void (tabId ? window.omp.system.openPath(resolvedPath, tabId) : window.omp.system.openPath(resolvedPath)).then(
				result => {
					if (!result?.ok) useUiStore.getState().openFilePreview(resolvedPath, line ? { line } : undefined);
				},
				error => toastError({ title: t("tools.path.openFailed"), error }),
			);
			return;
		}
		useUiStore.getState().openFilePreview(resolvedPath, line ? { line } : undefined);
	};

	return (
		<>
			<Tooltip content={fullTitle}>
				<LinkButton
					className={cx("omp-file-line-chip", className)}
					data-file-line-chip={resolvedPath}
					data-file-line={line !== undefined ? String(line) : undefined}
					onClick={event => {
						event.stopPropagation();
						handleOpen();
					}}
					onContextMenu={event => {
						event.stopPropagation();
						linkMenu.onContextMenu(event, { kind: "path", path: resolvedPath, line, dir: false });
					}}
					tone="inherit"
				>
					<FileCode2 aria-hidden className="omp-file-line-chip-icon" />
					<span className="omp-file-line-chip-name">{displayName}</span>
					{lineSuffix ? <span className="omp-file-line-chip-line">{lineSuffix}</span> : null}
				</LinkButton>
			</Tooltip>
			{linkMenu.menu}
		</>
	);
}
