import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isClaudeKeyProvider } from "./claude-key-id";

const SOURCE = "anthropic:/v1/models";
const receiptPath = (dir: string) => join(dir, "ompdesk-claude-key-receipts.sqlite");

type Receipt = { generation: string; replacedGeneration?: string; confirmedAt?: number; models: string[] };
type Stored = {
	fingerprint: string;
	generation: string;
	source: string | null;
	confirmedAt: number | null;
	models: string;
};

function checkBinding(provider: string, fingerprint: string): void {
	if (!isClaudeKeyProvider(provider) || !/^[a-f0-9]{64}$/.test(fingerprint)) {
		throw new Error("Expected a dedicated Claude API key fingerprint");
	}
}

function bindingFile(dir: string, provider: string, fingerprint: string): string {
	checkBinding(provider, fingerprint);
	const file = receiptPath(dir);
	if (!existsSync(file)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		try {
			// SQLite inherits the database file's permissions for its rollback journal.
			closeSync(openSync(file, "wx", 0o600));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	return file;
}

function withReceipts<T>(file: string, mode: "read" | "write", use: (db: Database) => T): T {
	const db = new Database(file, mode === "read" ? { readonly: true } : { readwrite: true });
	try {
		db.exec("PRAGMA busy_timeout = 1000");
		if (mode === "write") {
			db.exec(`CREATE TABLE IF NOT EXISTS receipts (
				provider TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, generation TEXT NOT NULL,
				source TEXT, confirmedAt INTEGER, models TEXT NOT NULL DEFAULT '[]'
			)`);
		}
		return use(db);
	} finally {
		db.close();
	}
}

export function currentKeyGeneration(dir: string, provider: string, fingerprint: string): string | undefined {
	const file = receiptPath(dir);
	if (!existsSync(file)) return undefined;
	return withReceipts(file, "read", db => {
		// Another process may have created the private file but not committed its schema yet.
		if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'receipts'").get()) return undefined;
		return db
			.query<{ generation: string }, [string, string]>(
				"SELECT generation FROM receipts WHERE provider = ? AND fingerprint = ?",
			)
			.get(provider, fingerprint)?.generation;
	});
}

export function keyReceipt(dir: string, provider: string, fingerprint: string): Receipt {
	return withReceipts(bindingFile(dir, provider, fingerprint), "write", db =>
		db
			.transaction((): Receipt => {
				const row = db.query<Stored, [string]>("SELECT * FROM receipts WHERE provider = ?").get(provider);
				if (row) {
					// Only a fresh GET for the changed config may claim this generation, never this read alone.
					if (row.fingerprint !== fingerprint)
						return { generation: "", replacedGeneration: row.generation, models: [] };
					return row.source === SOURCE && row.confirmedAt !== null
						? { generation: row.generation, confirmedAt: row.confirmedAt, models: JSON.parse(row.models) }
						: { generation: row.generation, models: [] };
				}
				const generation = randomUUID();
				db.query("INSERT INTO receipts (provider, fingerprint, generation) VALUES (?, ?, ?)").run(
					provider,
					fingerprint,
					generation,
				);
				return { generation, models: [] };
			})
			.immediate(),
	);
}

export function confirmKeyReceipt(
	dir: string,
	provider: string,
	fingerprint: string,
	generation: string,
	confirmedAt: number,
	models: string[],
): void {
	if (!generation) return;
	const file = receiptPath(dir);
	if (!existsSync(file)) return;
	withReceipts(file, "write", db => {
		db.query(`UPDATE receipts SET source = ?, confirmedAt = ?, models = ?
			WHERE provider = ? AND fingerprint = ? AND generation = ? AND (confirmedAt IS NULL OR confirmedAt < ?)`).run(
			SOURCE,
			confirmedAt,
			JSON.stringify(models),
			provider,
			fingerprint,
			generation,
			confirmedAt,
		);
	});
}

export function bindConfirmedReplacement(
	dir: string,
	provider: string,
	fingerprint: string,
	replacedGeneration: string,
	confirmedAt: number,
	models: string[],
): string | undefined {
	const file = receiptPath(dir);
	if (!replacedGeneration || !existsSync(file)) return undefined;
	checkBinding(provider, fingerprint);
	return withReceipts(file, "write", db => {
		const generation = randomUUID();
		const { changes } = db
			.query(`UPDATE receipts SET fingerprint = ?, generation = ?, source = ?, confirmedAt = ?, models = ?
			WHERE provider = ? AND generation = ? AND fingerprint != ?`)
			.run(
				fingerprint,
				generation,
				SOURCE,
				confirmedAt,
				JSON.stringify(models),
				provider,
				replacedGeneration,
				fingerprint,
			);
		return changes === 1 ? generation : undefined;
	});
}

export function registerKeyReceipt(
	dir: string,
	provider: string,
	fingerprint: string,
	confirmedAt: number,
	models: string[],
): void {
	withReceipts(bindingFile(dir, provider, fingerprint), "write", db => {
		db.query(`INSERT OR REPLACE INTO receipts (provider, fingerprint, generation, source, confirmedAt, models)
			VALUES (?, ?, ?, ?, ?, ?)`).run(
			provider,
			fingerprint,
			randomUUID(),
			SOURCE,
			confirmedAt,
			JSON.stringify(models),
		);
	});
}

export function forgetKeyReceipt(dir: string, provider: string): void {
	const file = receiptPath(dir);
	if (!existsSync(file)) return;
	withReceipts(file, "write", db => {
		db.query("DELETE FROM receipts WHERE provider = ?").run(provider);
	});
}
