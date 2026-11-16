/** Stage the unmodified public Brave release; --check admits an existing cache without downloading or launching it. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { promises as fsp } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import pin from "../resources/preview-browser.json";

const ROOT = path.resolve(import.meta.dir, "..", "resources", "preview-browser");
const RECORD = "provenance.json";
type TargetKey = keyof typeof pin.targets;
type Target = (typeof pin.targets)[TargetKey];
interface Signature {
	kind: "codesign" | "authenticode";
	identity: string;
	details: string;
}
interface Payload {
	sha256: string;
	treeSha256: string;
	licenses: string[];
	thirdPartyNotices: string[];
}

function targetKey(): TargetKey {
	const key = `${process.platform}-${process.arch}`;
	if (key !== "darwin-arm64" && key !== "win32-x64")
		throw new Error(`Preview browser staging requires its shipping OS/architecture, not ${key}`);
	return key;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inside(root: string, file: string): void {
	const relative = path.relative(root, file);
	if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
		throw new Error(`Browser payload path escapes its owned directory: ${file}`);
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
	const result = spawnSync(command, args, {
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 300_000,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(`${command} failed (${result.status ?? result.signal}): ${result.stderr}${result.stdout}`);
	return `${result.stdout}${result.stderr}`.trim();
}

async function fileHash(file: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
	return hash.digest("hex");
}

async function download(target: Target, file: string): Promise<void> {
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8 * 60_000)]);
	const response = await fetch(target.url, { signal });
	if (!response.ok || !response.body) throw new Error(`Brave download failed: HTTP ${response.status}`);
	if (new URL(response.url).protocol !== "https:") throw new Error("Brave download redirected outside HTTPS");
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	let size = 0;
	async function* chunks(): AsyncGenerator<Uint8Array> {
		let complete = false;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					complete = true;
					break;
				}
				size += value.byteLength;
				if (size > target.size) throw new Error("Brave archive exceeds its pinned byte count");
				hash.update(value);
				yield value;
			}
		} finally {
			if (!complete) controller.abort();
			reader.releaseLock();
		}
	}
	await pipeline(chunks(), fs.createWriteStream(file, { flags: "wx", mode: 0o600 }));
	if (size !== target.size || hash.digest("hex") !== target.sha256)
		throw new Error(`Brave archive size/SHA-256 mismatch: ${target.archive}`);
}

const POWERSHELL_PREFIX = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
`;

function powershell(script: string, env: Record<string, string>): string {
	return run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PREFIX + script], {
		...process.env,
		...env,
	});
}

function extractWindows(archive: string, vendor: string): void {
	powershell(
		`
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($env:OMP_PREVIEW_ARCHIVE)
try {
  $root = [System.IO.Path]::GetFullPath($env:OMP_PREVIEW_VENDOR).TrimEnd('\\') + '\\'
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\\')
    if ($name.Contains(':') -or [System.IO.Path]::IsPathRooted($name) -or ($name.Split('\\') -contains '..')) {
      throw "Unsafe ZIP entry: $name"
    }
    $destination = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $name))
    if (!$destination.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or !$seen.Add($destination)) {
      throw "Escaping or duplicate ZIP entry: $name"
    }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "ZIP symlink requires inspection: $name" }
    $total += $entry.Length
    if ($total -gt 4294967296) { throw 'Browser ZIP exceeds 4 GiB unpacked' }
  }
} finally { $zip.Dispose() }
[System.IO.Compression.ZipFile]::ExtractToDirectory($env:OMP_PREVIEW_ARCHIVE, $env:OMP_PREVIEW_VENDOR)
`,
		{ OMP_PREVIEW_ARCHIVE: archive, OMP_PREVIEW_VENDOR: vendor },
	);
}

async function extractMac(archive: string, vendor: string, workspace: string): Promise<void> {
	const mount = path.join(workspace, "mount");
	await fsp.mkdir(mount);
	let mounted = false;
	const failures: unknown[] = [];
	try {
		run("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, archive]);
		mounted = true;
		const source = path.join(mount, "Brave Browser.app");
		if (!(await fsp.lstat(source)).isDirectory()) throw new Error("Official DMG does not contain Brave Browser.app");
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
		run("/usr/bin/ditto", ["--rsrc", "--extattr", source, path.join(vendor, "Brave Browser.app")]);
	} catch (error) {
		failures.push(error);
	}
	if (mounted) {
		try {
			run("/usr/bin/hdiutil", ["detach", mount]);
			await fsp.rmdir(mount);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Brave DMG extraction or detach failed");
}

async function signature(dir: string, target: Target): Promise<Signature> {
	if ((await fsp.lstat(path.join(dir, "vendor"))).isSymbolicLink())
		throw new Error("Browser vendor directory must not be a symlink");
	const vendor = await fsp.realpath(path.join(dir, "vendor"));
	inside(await fsp.realpath(dir), vendor);
	const binary = await fsp.realpath(path.join(dir, target.binary));
	inside(vendor, binary);
	if (!(await fsp.stat(binary)).isFile()) throw new Error("Browser executable is not a regular file");
	if ("teamId" in target) {
		await fsp.access(binary, fs.constants.X_OK);
		const app = path.join(dir, "vendor", "Brave Browser.app");
		run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
		const details = run("/usr/bin/codesign", ["--display", "--verbose=4", app]);
		if (!details.split(/\r?\n/).includes(`TeamIdentifier=${target.teamId}`))
			throw new Error("Brave app does not have its pinned vendor TeamIdentifier");
		const bundleId = run("/usr/bin/plutil", [
			"-extract",
			"CFBundleIdentifier",
			"raw",
			"-o",
			"-",
			path.join(app, "Contents", "Info.plist"),
		]);
		if (bundleId !== target.bundleId) throw new Error("Brave app bundle identifier differs from the pin");
		return { kind: "codesign", identity: target.teamId, details };
	}
	const output = powershell(
		`
$signature = Get-AuthenticodeSignature -LiteralPath $env:OMP_PREVIEW_BINARY
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { throw "Invalid Brave Authenticode: $($signature.Status)" }
$thumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
$allowed = ConvertFrom-Json $env:OMP_PREVIEW_SIGNERS
if ($allowed -notcontains $thumbprint) { throw "Brave signer is not in the pinned official signing policy: $thumbprint" }
[ordered]@{ status = 'Valid'; thumbprint = $thumbprint; subject = $signature.SignerCertificate.Subject } | ConvertTo-Json -Compress
`,
		{ OMP_PREVIEW_BINARY: binary, OMP_PREVIEW_SIGNERS: JSON.stringify(target.authenticodeThumbprints) },
	);
	const result: unknown = JSON.parse(output);
	if (!record(result) || result.status !== "Valid" || typeof result.thumbprint !== "string")
		throw new Error("Authenticode did not return an actual validated signer");
	return { kind: "authenticode", identity: result.thumbprint, details: output };
}

async function inspect(dir: string, target: Target): Promise<Payload> {
	const vendor = await fsp.realpath(path.join(dir, "vendor"));
	const executable = await fsp.realpath(path.join(dir, target.binary));
	inside(vendor, executable);
	const tree = createHash("sha256");
	let binaryHash = "";
	const licenses: string[] = [];
	const thirdPartyNotices: string[] = [];
	async function walk(folder: string): Promise<void> {
		for (const name of (await fsp.readdir(folder)).sort()) {
			const file = path.join(folder, name);
			const relative = path.relative(vendor, file).split(path.sep).join("/");
			const stat = await fsp.lstat(file);
			if (stat.isSymbolicLink()) {
				const link = await fsp.readlink(file);
				inside(vendor, await fsp.realpath(file));
				tree.update(`${JSON.stringify([relative, "symlink", link])}\n`);
			} else if (stat.isDirectory()) {
				tree.update(`${JSON.stringify([relative, "directory", stat.mode & 0o777])}\n`);
				await walk(file);
			} else if (stat.isFile()) {
				const sha256 = await fileHash(file);
				tree.update(`${JSON.stringify([relative, "file", stat.mode & 0o777, stat.size, sha256])}\n`);
				if (file === executable) binaryHash = sha256;
				if (
					(!path.extname(name) || /\.(?:html?|txt|md)$/i.test(name)) &&
					/license|credits|third.?party/i.test(name) &&
					stat.size > 0 &&
					stat.size <= 32 * 1024 * 1024
				) {
					const text = await fsp.readFile(file, "utf8");
					if (text.includes("Mozilla Public License") && /Version\s+2\.0/.test(text)) licenses.push(relative);
					if (
						/credits|third.?party|licenses[._-]chromium/i.test(name) &&
						/copyright/i.test(text) &&
						/redistribution and use|permission is hereby granted/i.test(text)
					)
						thirdPartyNotices.push(relative);
				}
			} else {
				throw new Error(`Unsupported vendor payload entry: ${relative}`);
			}
		}
	}
	await walk(vendor);
	if (!binaryHash) throw new Error("Executable is not an inventoried regular file within the vendor payload");
	if (!licenses.length || !thirdPartyNotices.length)
		throw new Error(
			"Official payload license/third-party credits layout is unverified: require actual nonempty MPL 2.0 and third-party notices files. Packed brave://credits is not presumed inspected; no runtime manifest is admitted.",
		);
	return { sha256: binaryHash, treeSha256: tree.digest("hex"), licenses, thirdPartyNotices };
}

function sourceOffer(payload: Payload): string {
	return [
		`${pin.vendor} ${pin.vendorVersion} (Chromium ${pin.chromiumVersion})`,
		`Unmodified official package: ${pin.release}`,
		`Brave ${pin.license} Covered Software source and versioned upstream dependencies:`,
		...pin.sources,
		"Each upstream dependency retains its own license; see its included notices.",
		`MPL terms: ${pin.licenseTerms}`,
		"These source locations identify the corresponding released versions and their dependency references.",
		"OMPdesk retains its own license; this offer does not replace any upstream license or notice.",
		"Original vendor marks, signatures, helpers, resources, and notices are retained in vendor/.",
		"Included MPL license files:",
		...payload.licenses.map(file => `vendor/${file}`),
		"Included third-party notices:",
		...payload.thirdPartyNotices.map(file => `vendor/${file}`),
		"",
	].join("\n");
}

function runtime(target: Target, sha256: string) {
	return { version: pin.chromiumVersion, platform: target.platform, arch: target.arch, binary: target.binary, sha256 };
}

async function readJson(file: string): Promise<unknown> {
	return JSON.parse(await fsp.readFile(file, "utf8"));
}

export async function checkPreviewBrowser(): Promise<void> {
	const key = targetKey();
	const target = pin.targets[key];
	if ((await fsp.lstat(ROOT)).isSymbolicLink()) throw new Error("Browser stage parent must not be a symlink");
	const dir = path.join(ROOT, key);
	if ((await fsp.lstat(dir)).isSymbolicLink()) throw new Error("Browser stage root must not be a symlink");
	const provenance = await readJson(path.join(dir, RECORD));
	if (
		!record(provenance) ||
		provenance.producer !== "ompdesk-preview-browser-v1" ||
		provenance.pinSha256 !== createHash("sha256").update(JSON.stringify(pin)).digest("hex") ||
		provenance.archiveSha256 !== target.sha256 ||
		provenance.archiveSize !== target.size
	)
		throw new Error("Preview browser cache does not match the pinned producer/archive");
	const verifiedSignature = await signature(dir, target);
	const payload = await inspect(dir, target);
	if (payload.treeSha256 !== provenance.vendorTreeSha256 || verifiedSignature.identity !== provenance.signer)
		throw new Error("Preview browser cache payload or signer changed");
	const actual = await readJson(path.join(dir, "runtime.json"));
	const expected = runtime(target, payload.sha256);
	if (
		!record(actual) ||
		Object.keys(actual).sort().join(",") !== Object.keys(expected).sort().join(",") ||
		Object.entries(expected).some(([field, value]) => actual[field] !== value)
	)
		throw new Error("Preview browser runtime.json differs from the strict five-key consumer contract");
	if ((await fsp.readFile(path.join(dir, "SOURCE-OFFER.txt"), "utf8")) !== sourceOffer(payload))
		throw new Error("Preview browser source offer is missing or changed");
	console.log(`[preview-browser] verified ${pin.vendorVersion} / Chromium ${pin.chromiumVersion} (${key})`);
}

export async function stagePreviewBrowser(): Promise<void> {
	const key = targetKey();
	const target = pin.targets[key];
	if (fs.existsSync(ROOT) && (await fsp.lstat(ROOT)).isSymbolicLink())
		throw new Error("Browser stage parent must not be a symlink");
	await fsp.mkdir(ROOT, { recursive: true });
	const workspace = await fsp.mkdtemp(path.join(ROOT, ".staging-"));
	const stage = path.join(workspace, "payload");
	const vendor = path.join(stage, "vendor");
	const destination = path.join(ROOT, key);
	const previous = path.join(workspace, "previous");
	const failures: unknown[] = [];
	try {
		await fsp.mkdir(vendor, { recursive: true });
		const archive = path.join(workspace, target.archive);
		await download(target, archive);
		if ("teamId" in target) await extractMac(archive, vendor, workspace);
		else extractWindows(archive, vendor);
		const verifiedSignature = await signature(stage, target);
		const payload = await inspect(stage, target);
		await fsp.writeFile(path.join(stage, "SOURCE-OFFER.txt"), sourceOffer(payload), { flag: "wx" });
		await fsp.writeFile(
			path.join(stage, RECORD),
			`${JSON.stringify(
				{
					producer: "ompdesk-preview-browser-v1",
					pinSha256: createHash("sha256").update(JSON.stringify(pin)).digest("hex"),
					vendorVersion: pin.vendorVersion,
					chromiumVersion: pin.chromiumVersion,
					assetId: target.assetId,
					archive: target.url,
					archiveSha256: target.sha256,
					archiveSize: target.size,
					vendorTreeSha256: payload.treeSha256,
					signer: verifiedSignature.identity,
					signature: verifiedSignature,
					licenses: payload.licenses,
					thirdPartyNotices: payload.thirdPartyNotices,
				},
				null,
				"\t",
			)}\n`,
			{ flag: "wx" },
		);
		await fsp.writeFile(
			path.join(stage, "runtime.json"),
			`${JSON.stringify(runtime(target, payload.sha256), null, "\t")}\n`,
			{ flag: "wx" },
		);
		let movedPrevious = false;
		if (fs.existsSync(destination)) {
			const stat = await fsp.lstat(destination);
			if (!stat.isDirectory() || stat.isSymbolicLink())
				throw new Error("Refusing to replace a linked or non-directory browser stage");
			const existing = await readJson(path.join(destination, RECORD));
			if (!record(existing) || existing.producer !== "ompdesk-preview-browser-v1")
				throw new Error("Refusing to replace a browser directory not owned by this producer");
			await fsp.rename(destination, previous);
			movedPrevious = true;
		}
		try {
			await fsp.rename(stage, destination);
		} catch (error) {
			if (movedPrevious) {
				try {
					await fsp.rename(previous, destination);
				} catch (rollbackError) {
					throw new AggregateError(
						[error, rollbackError],
						`Browser stage failed; previous payload retained at ${previous}`,
					);
				}
			}
			throw error;
		}
	} catch (error) {
		failures.push(error);
	}
	// Never traverse a DMG that failed to detach, or erase the only preserved rollback payload.
	if (fs.existsSync(path.join(workspace, "mount")) || fs.existsSync(previous)) {
		if (failures.length)
			throw new AggregateError(failures, `Browser staging failed; inspect owned workspace ${workspace}`);
	}
	try {
		await fsp.rm(workspace, { recursive: true, force: true });
	} catch (error) {
		failures.push(error);
	}
	if (failures.length) throw new AggregateError(failures, "Preview browser staging failed");
	console.log(`[preview-browser] staged ${pin.vendorVersion} / Chromium ${pin.chromiumVersion} (${key})`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 0) await stagePreviewBrowser();
	else if (args.length === 1 && args[0] === "--check") await checkPreviewBrowser();
	else throw new Error("Usage: bun scripts/stage-preview-browser.ts [--check]");
}
