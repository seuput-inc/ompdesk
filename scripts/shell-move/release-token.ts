// bun release-token.ts <OMPdesk.app> <userData>: does the stored update token of a moved profile still decrypt to the seeded one, offline.
// A published app has no page to ask (no WebDriver, no inspector), so this does what its main does: the host answers the keychain
// item's password (`ompdesk-shell --keychain-key <userData>`, `{"kind":"mac-v10","password":<base64>}`, no dialog), and
// `<userData>/update-token.bin` is OSCrypt's macOS `v10` value: AES-128-CBC, PKCS7, IV of 16 spaces, key = PBKDF2-HMAC-SHA1(password
// bytes, "saltysalt", 1003 rounds) (native/ompdesk/crates/shell/src/migrate/safe_storage.rs). The seeded token is STAND_IN_TOKEN.
// Prints one JSON line of booleans and lengths; the token and the password are never printed.
import { createDecipheriv, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [app, userData] = process.argv.slice(2);
const seeded = process.env.STAND_IN_TOKEN;
if (!app || !userData || !seeded)
	throw new Error("usage: STAND_IN_TOKEN=<seeded> bun release-token.ts <OMPdesk.app> <userData>");

function answer(fields: Record<string, unknown>): never {
	console.log(JSON.stringify({ equalsSeeded: false, ...fields }));
	process.exit(0);
}

const asked = Bun.spawnSync([join(app, "Contents", "MacOS", "ompdesk-shell"), "--keychain-key", userData], {
	stdout: "pipe",
	stderr: "pipe",
	timeout: 30_000,
});
const line = asked.stdout.toString().trim().split("\n").pop() ?? "";
let key: unknown;
try {
	key = JSON.parse(line);
} catch {
	answer({ keychain: "no JSON answer", exit: asked.exitCode });
}
if (key === null || typeof key !== "object") answer({ keychain: "not an object" });
if (!("kind" in key) || key.kind !== "mac-v10" || !("password" in key) || typeof key.password !== "string") {
	answer({ keychain: "unavailable" in key ? String(key.unavailable).slice(0, 160) : "no mac-v10 key" });
}

let blob: Buffer;
try {
	blob = readFileSync(join(userData, "update-token.bin"));
} catch (error) {
	answer({ keychain: "mac-v10", tokenFile: false, why: error instanceof Error ? error.message : String(error) });
}
if (blob.subarray(0, 3).toString("latin1") !== "v10")
	answer({ keychain: "mac-v10", tokenFile: true, prefix: "not v10" });
try {
	const derived = pbkdf2Sync(Buffer.from(key.password, "base64"), "saltysalt", 1003, 16, "sha1");
	const decipher = createDecipheriv("aes-128-cbc", derived, Buffer.alloc(16, 0x20));
	const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
	const expected = Buffer.from(seeded);
	console.log(
		JSON.stringify({
			keychain: "mac-v10",
			tokenFile: true,
			decrypted: true,
			length: plain.length,
			equalsSeeded: plain.length === expected.length && timingSafeEqual(plain, expected),
		}),
	);
} catch {
	answer({
		keychain: "mac-v10",
		tokenFile: true,
		decrypted: false,
		why: "the ciphertext does not decrypt with this key",
	});
}
