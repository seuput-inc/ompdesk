/**
 * The owner's mail accounts for email routines (contract `src/shared/mail-accounts.ts`). The accounts live in
 * `<userData>/mail-accounts.json` (no password in it); each password in `<userData>/mail-accounts/<id>.bin`, encrypted
 * by the OS keystore (`secret-files.ts`). A password is decrypted only to log in, kept in memory after its first use,
 * and never returned, logged or put in an error.
 *
 * The private core pipe receives login parameters only when a poll is about to start.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAIL_DEFAULT_MAILBOX,
	MAIL_DEFAULT_PORT,
	type MailAccount,
	type MailAccountDraft,
	type MailAccountsState,
	type MailAccountTest,
	mailAccountProblem,
} from "../shared/mail-accounts";
import { writeFileAtomicSync } from "./atomic-file";
import { type MailboxRead, type MailCursor, readMailbox } from "./routines/imap";
import { type SecretBox, SecretFiles, SecretReadError } from "./secret-files";

export interface MailAccountsOptions {
	/** `<userData>`. */
	dir: string;
	box: SecretBox;
	/** Test launches connect only to IPv4 loopback without TLS. */
	plainLoopback?: boolean;
	/**
	 * Whether a password saved this run is kept in memory (default). The parity sheet's launch turns it off so an
	 * account it saves reads as one whose password was not opened yet (`OMP_GUI_TEST_KEYCHAIN_WOULD_ASK`, index.ts).
	 */
	rememberSaved?: boolean;
	/** Told after every change (the window's list). */
	onChange?: (state: MailAccountsState) => void;
}

type Stored = Omit<MailAccount, "hasPassword" | "address" | "needsReentry">;

export class MailAccounts {
	readonly #options: MailAccountsOptions;
	#accounts: Stored[];
	readonly #secrets: SecretFiles;

	constructor(options: MailAccountsOptions) {
		this.#options = options;
		this.#accounts = this.#load();
		this.#secrets = new SecretFiles({
			dir: join(options.dir, "mail-accounts"),
			box: options.box,
			ids: () => this.#accounts.map(account => account.id),
			...(options.rememberSaved === false ? { rememberSaved: false } : {}),
		});
	}

	state(): MailAccountsState {
		return {
			accounts: this.#accounts.map(account => {
				const needsReentry = this.#secrets.needsReentry(account.id);
				return {
					...account,
					address: account.username.includes("@") ? account.username : "",
					hasPassword: !needsReentry && this.#secrets.has(account.id),
					needsReentry,
				};
			}),
		};
	}

	/** Saves a new account (no `id`) or an edit; an edit without a password keeps the stored one. */
	save(draft: MailAccountDraft, id?: string): MailAccountsState {
		const existing = id === undefined ? undefined : this.#find(id);
		const clean: MailAccountDraft = {
			label: String(draft.label ?? "").trim(),
			host: String(draft.host ?? "").trim(),
			port: Number(draft.port ?? MAIL_DEFAULT_PORT),
			username: String(draft.username ?? "").trim(),
			mailbox: String(draft.mailbox ?? "").trim() || MAIL_DEFAULT_MAILBOX,
			...(typeof draft.password === "string" && draft.password !== "" ? { password: draft.password } : {}),
		};
		const problem = mailAccountProblem(
			clean,
			existing !== undefined && this.state().accounts.some(a => a.id === id && a.hasPassword),
		);
		if (problem) throw new Error(`Invalid mail account: ${problem}`);
		const label = clean.label.toLowerCase();
		if (this.#accounts.some(account => account.id !== id && account.label.toLowerCase() === label))
			throw new Error("Invalid mail account: label (another account has it)");
		const accountId = existing?.id ?? randomUUID();
		if (clean.password !== undefined) this.#secrets.save(accountId, clean.password);
		const stored: Stored = {
			id: accountId,
			label: clean.label,
			host: clean.host,
			port: clean.port,
			username: clean.username,
			mailbox: clean.mailbox,
		};
		this.#accounts = existing
			? this.#accounts.map(account => (account.id === accountId ? stored : account))
			: [...this.#accounts, stored];
		this.#write();
		return this.state();
	}

	remove(id: string): MailAccountsState {
		this.#find(id);
		this.#accounts = this.#accounts.filter(account => account.id !== id);
		this.#secrets.remove(id);
		this.#write();
		return this.state();
	}

	/** The account an email routine names, by id or label (case aside). */
	resolve(name: string): { id: string; label: string; address: string } | null {
		const wanted = name.trim().toLowerCase();
		const account = this.state().accounts.find(
			item => item.id === name.trim() || item.label.toLowerCase() === wanted,
		);
		return account ? { id: account.id, label: account.label, address: account.address } : null;
	}

	/** Main → core only. Never part of account state, events, logs or a renderer response. */
	pollAccount(name: string) {
		const account = this.resolve(name);
		return account ? { ...account, connection: this.#connection(account.id) } : null;
	}

	#connection(id: string) {
		const account = this.#find(id);
		return {
			host: account.host,
			port: account.port,
			plainLoopback: this.#options.plainLoopback ?? false,
			login: { username: account.username, password: this.#password(id), mailbox: account.mailbox },
			timeoutMs: 30_000,
		};
	}

	async read(id: string, cursor: MailCursor | null): Promise<MailboxRead> {
		const { login, timeoutMs, ...endpoint } = this.#connection(id);
		return readMailbox(endpoint, login, cursor, timeoutMs);
	}

	/** Log in and open the mailbox once, as a poll does; the reason in words when it cannot. */
	async test(id: string): Promise<MailAccountTest> {
		try {
			const read = await this.read(id, null);
			return { ok: true, messages: read.exists };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	#find(id: string): Stored {
		const account = this.#accounts.find(item => item.id === id);
		if (!account) throw new Error("Mail account not found");
		return account;
	}

	#password(id: string): string {
		try {
			return this.#secrets.read(id);
		} catch (error) {
			if (!(error instanceof SecretReadError)) throw error;
			throw new Error(
				error.reason === "missing"
					? "no password is stored for this account (Settings › Schedules › Email accounts)"
					: error.reason === "blocked"
						? "its stored password cannot be read without macOS asking for your login password; enter it again in Settings › Schedules › Email accounts"
						: "its stored password could not be read on this computer; enter it again in Settings",
			);
		}
	}

	#file(): string {
		return join(this.#options.dir, "mail-accounts.json");
	}

	#load(): Stored[] {
		try {
			const parsed = JSON.parse(readFileSync(this.#file(), "utf8")) as { accounts?: unknown };
			if (!Array.isArray(parsed.accounts)) return [];
			return parsed.accounts.filter(
				(item): item is Stored =>
					typeof item?.id === "string" && mailAccountProblem({ ...item, password: undefined }, true) === null,
			);
		} catch {
			return [];
		}
	}

	#write(): void {
		writeFileAtomicSync(this.#file(), JSON.stringify({ version: 1, accounts: this.#accounts }, null, 2), {
			mode: 0o600,
		});
		this.#options.onChange?.(this.state());
	}
}
