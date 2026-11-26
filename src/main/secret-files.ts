/**
 * Secrets kept one file each, `<dir>/<id>.bin`, encrypted by the OS keystore (`SecretBox`: Electron `safeStorage` in
 * the app, the shim's on the Tauri host). A secret is decrypted only when it is used and kept in memory after its first
 * use (on macOS each keystore read can ask for the login password after an update, see update-auth.ts); it is never
 * returned to a window, logged or put in an error. Mail accounts (`mail-accounts.ts`) and tracker accounts
 * (`tracker-accounts.ts`) keep theirs here.
 *
 * Main keeps them (native-rust › Ledger: safeStorage stays with the credential consumer, and the core has no keystore).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { codedError } from "../shared/ipc-error-codes";
import { KEYCHAIN_WOULD_ASK } from "../shared/keychain";
import { writeFileAtomicSync } from "./atomic-file";

/** The OS keystore as the stores use it. */
export interface SecretBox {
	available(): boolean;
	/**
	 * `KEYCHAIN_WOULD_ASK` when the keystore refused to open without asking the person (it stays so for the run); null
	 * otherwise. Asking settles the keystore, so a store asks only when it holds a stored secret it has not read.
	 */
	blocked?(): string | null;
	encrypt(text: string): Buffer;
	decrypt(data: Buffer): string;
}

/** Why a stored secret could not be read: none stored, the keystore would ask, or it does not decrypt here. */
export class SecretReadError extends Error {
	constructor(readonly reason: "missing" | "blocked" | "unreadable") {
		super(`secret ${reason}`);
		this.name = "SecretReadError";
	}
}

export interface SecretFilesOptions {
	dir: string;
	box: SecretBox;
	/** The ids whose secrets the store holds, for whether asking the keystore is due. */
	ids: () => readonly string[];
	/** Whether a secret saved this run is kept in memory (default). */
	rememberSaved?: boolean;
}

export class SecretFiles {
	readonly #options: SecretFilesOptions;
	/** Secrets decrypted (or saved) this launch, by id. */
	readonly #known = new Map<string, string>();
	/** `#blocked`'s answer once it was asked; undefined before. */
	#blockedAnswer: boolean | undefined;

	constructor(options: SecretFilesOptions) {
		this.#options = options;
	}

	/**
	 * Whether the keystore refused to open without asking, asked once and only when a secret is stored that this run
	 * has not read: a store without one, or one already read, never touches the keystore.
	 */
	#blocked(): boolean {
		if (this.#blockedAnswer === undefined) {
			const pending = this.#options.ids().some(id => !this.#known.has(id) && this.has(id));
			if (!pending) return false;
			this.#blockedAnswer = this.#options.box.blocked?.() === KEYCHAIN_WOULD_ASK;
		}
		return this.#blockedAnswer;
	}

	#file(id: string): string {
		return join(this.#options.dir, `${id.replace(/[^\w-]/g, "")}.bin`);
	}

	/** A secret is stored for `id` (read or not). */
	has(id: string): boolean {
		return this.#known.has(id) || existsSync(this.#file(id));
	}

	/** Its stored secret cannot be read this run without the keystore asking: it must be entered again. */
	needsReentry(id: string): boolean {
		return !this.#known.has(id) && existsSync(this.#file(id)) && this.#blocked();
	}

	/** Encrypts and stores `secret`; refuses (`keychain_would_ask`, or in words) where it cannot be kept safely. */
	save(id: string, secret: string): void {
		if (!this.#options.box.available()) {
			if (this.#options.box.blocked?.() === KEYCHAIN_WOULD_ASK)
				throw codedError("keychain_would_ask", "macOS would ask for the login password to open the keychain");
			throw new Error("This computer cannot store a password safely");
		}
		writeFileAtomicSync(this.#file(id), this.#options.box.encrypt(secret).toString("base64"), {
			mode: 0o600,
			dirMode: 0o700,
		});
		if (this.#options.rememberSaved !== false) this.#known.set(id, secret);
	}

	/** The secret; `SecretReadError` when there is none or it cannot be read here. */
	read(id: string): string {
		const known = this.#known.get(id);
		if (known !== undefined) return known;
		let data: Buffer;
		try {
			data = Buffer.from(readFileSync(this.#file(id), "utf8"), "base64");
		} catch {
			throw new SecretReadError("missing");
		}
		if (this.#blocked()) throw new SecretReadError("blocked");
		let secret: string;
		try {
			secret = this.#options.box.decrypt(data);
		} catch {
			throw new SecretReadError("unreadable");
		}
		this.#known.set(id, secret);
		return secret;
	}

	remove(id: string): void {
		this.#known.delete(id);
		rmSync(this.#file(id), { force: true });
	}
}
