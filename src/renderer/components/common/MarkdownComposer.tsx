/**
 * MarkdownComposer — a Markdown text box for GitHub (a PR review or reply, an issue or PR body): Write and Preview
 * tabs (Orca `github/GitHubMarkdownComposer*.tsx`, `github-markdown-composer-preview-pane.tsx`), an @mention list of
 * the repository's people (Orca `pull-request-page/mentions/textarea.tsx`), and pasted or dropped images uploaded
 * through `onImage` (Orca `github/use-github-image-paste.ts`).
 *
 * Rules:
 * - Preview renders what Write holds through `MarkdownRenderer` as typed text (`userText`); an empty box previews a
 *   muted line, never a blank pane.
 * - The @ list opens while the word at the caret is `@` and letters, shows up to eight logins that start with them,
 *   and takes ↑/↓, Enter or Tab (never an IME's commit Enter) and Escape; the field keeps focus and names the row with
 *   `aria-activedescendant`. A press on a row picks it.
 * - An image is inserted as `![name](url)` at the caret once `onImage` answers a URL; while it uploads a muted line
 *   says so; `onImage` tells its own failure (the box only stays as it was). Without `onImage` a pasted image falls
 *   through to the text field.
 * - ⌘/Ctrl+Enter runs `onSubmit`.
 */

import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { MarkdownRenderer } from "../../lib/markdown";
import { TextArea } from "./Input";
import { OptionRow } from "./OptionRow";
import { Tabs } from "./Tabs";

/** The most logins the @ list offers at once. */
const MENTIONS_SHOWN = 8;

export interface MarkdownComposerProps {
	value: string;
	onChange: (value: string) => void;
	/** The field's name: a visible label, else `ariaLabel`. */
	label?: ReactNode;
	ariaLabel?: string;
	placeholder?: string;
	rows?: number;
	disabled?: boolean;
	/** Logins the @ list offers. */
	mentions?: readonly string[];
	/** Uploads one image and answers its URL, or null when it could not (and said why). */
	onImage?: (file: File) => Promise<string | null>;
	/** ⌘/Ctrl+Enter. */
	onSubmit?: () => void;
	className?: string;
}

/** The `@word` that ends at `caret`, its start and its letters; null when the caret is in no such word. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
	const match = /(^|\s)@([A-Za-z0-9-]{0,39})$/.exec(text.slice(0, caret));
	return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

export function MarkdownComposer({
	value,
	onChange,
	label,
	ariaLabel,
	placeholder,
	rows = 4,
	disabled,
	mentions = [],
	onImage,
	onSubmit,
	className,
}: MarkdownComposerProps) {
	const t = useT();
	const listId = useId();
	const fieldRef = useRef<HTMLTextAreaElement>(null);
	const [tab, setTab] = useState<"write" | "preview">("write");
	const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
	const [active, setActive] = useState(0);
	const [uploading, setUploading] = useState(0);

	const matches = mention
		? mentions.filter(login => login.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, MENTIONS_SHOWN)
		: [];
	const listOpen = matches.length > 0;

	const look = (text: string, caret: number | null) => {
		const next = caret === null ? null : mentionAt(text, caret);
		setMention(next);
		if (next?.query !== mention?.query) setActive(0);
	};

	const insert = (text: string, from: number, to: number) => {
		const next = value.slice(0, from) + text + value.slice(to);
		onChange(next);
		const caret = from + text.length;
		requestAnimationFrame(() => {
			fieldRef.current?.focus();
			fieldRef.current?.setSelectionRange(caret, caret);
		});
	};

	const pick = (login: string) => {
		if (!mention) return;
		const caret = fieldRef.current?.selectionStart ?? mention.start + mention.query.length + 1;
		insert(`@${login} `, mention.start, caret);
		setMention(null);
	};

	const upload = async (files: File[]) => {
		if (!onImage) return;
		for (const file of files) {
			setUploading(count => count + 1);
			try {
				const url = await onImage(file);
				const at = fieldRef.current?.selectionStart ?? value.length;
				if (url) insert(`![${file.name.replace(/[[\]]/g, "")}](${url})`, at, at);
			} finally {
				setUploading(count => count - 1);
			}
		}
	};
	const images = (list: FileList | null) => Array.from(list ?? []).filter(file => file.type.startsWith("image/"));

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isImeKeyEvent(event)) return;
		if (listOpen) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setActive(index => (index + step + matches.length) % matches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				pick(matches[active] ?? matches[0]);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				setMention(null);
				return;
			}
		}
		if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
			event.preventDefault();
			onSubmit();
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = images(event.clipboardData.files);
		if (!onImage || files.length === 0) return;
		event.preventDefault();
		void upload(files);
	};
	const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
		const files = images(event.dataTransfer.files);
		if (!onImage || files.length === 0) return;
		event.preventDefault();
		void upload(files);
	};

	return (
		<div className={className} data-markdown-composer>
			<Tabs
				activeId={tab}
				ariaLabel={t("markdownComposer.mode")}
				compact
				onChange={id => setTab(id === "preview" ? "preview" : "write")}
				tabs={[
					{ id: "write", label: t("markdownComposer.write") },
					{ id: "preview", label: t("markdownComposer.preview") },
				]}
				variant="segmented"
			/>
			<div className="relative mt-1.5">
				{tab === "write" ? (
					<TextArea
						aria-activedescendant={listOpen ? `${listId}-${active}` : undefined}
						aria-autocomplete={mentions.length > 0 ? "list" : undefined}
						aria-controls={listOpen ? listId : undefined}
						aria-expanded={mentions.length > 0 ? listOpen : undefined}
						aria-label={label ? undefined : ariaLabel}
						autoGrow
						disabled={disabled}
						label={label}
						onBlur={() => setMention(null)}
						onChange={event => {
							onChange(event.target.value);
							look(event.target.value, event.target.selectionStart);
						}}
						onClick={event => look(event.currentTarget.value, event.currentTarget.selectionStart)}
						onDrop={onDrop}
						onKeyDown={onKeyDown}
						onPaste={onPaste}
						placeholder={placeholder}
						ref={fieldRef}
						rows={rows}
						value={value}
					/>
				) : (
					<div
						aria-label={t("markdownComposer.preview")}
						className="min-h-20 rounded-(--sc-radius-md) border border-(--sc-border-subtle) px-3 py-2 text-sc-sm"
						role="region"
					>
						{value.trim() ? (
							<MarkdownRenderer content={value} userText />
						) : (
							<p className="text-(--sc-text-muted)">{t("markdownComposer.nothing")}</p>
						)}
					</div>
				)}
				{tab === "write" && listOpen && (
					<div
						aria-label={t("markdownComposer.mentions")}
						className="omp-floating absolute left-0 z-10 mt-1 flex max-h-64 w-64 flex-col overflow-y-auto rounded-(--sc-radius-md) border border-(--sc-border-subtle) p-1"
						id={listId}
						role="listbox"
					>
						{matches.map((login, index) => (
							<OptionRow
								active={index === active}
								id={`${listId}-${index}`}
								key={login}
								// The field keeps focus: a press picks without blurring it first.
								onMouseDown={event => {
									event.preventDefault();
									pick(login);
								}}
								size="xs"
							>
								<span className="truncate text-sc-sm">@{login}</span>
							</OptionRow>
						))}
					</div>
				)}
			</div>
			{uploading > 0 && (
				<p aria-live="polite" className="mt-1 text-sc-xs text-(--sc-text-muted)">
					{t("markdownComposer.uploading")}
				</p>
			)}
		</div>
	);
}
