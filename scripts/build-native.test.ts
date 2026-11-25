import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { checkCompilerInputs, sourceSha256 } from "./build-native";

it("reuses the native release build for integration-test and shell changes, not for inputs to either binary", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-build-inputs-"));
	function put(name: string, bytes: string): void {
		const file = path.join(root, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, bytes);
	}
	try {
		const inputs = [
			"scripts/build-native.ts",
			"scripts/cargo.ts",
			".cargo/config.toml",
			"native/ompdesk/Cargo.toml",
			"native/ompdesk/Cargo.lock",
			"native/ompdesk/rust-toolchain.toml",
			"native/ompdesk/crates/core/src/main.rs",
			"native/ompdesk/crates/cli/Cargo.toml",
			"native/ompdesk/crates/checks/src/reporters/playwright.cjs",
			"native/ompdesk/crates/new-member/build.rs",
		];
		for (const name of inputs) put(name, "before");
		const before = sourceSha256(root);
		for (const name of [
			"cli/tests/admission.rs",
			"tauri-shell/src/watchdog.rs",
			"shell/src/lib.rs",
			"shell-preview/Cargo.toml",
		]) {
			put(`native/ompdesk/crates/${name}`, "not linked");
		}
		expect(sourceSha256(root)).toBe(before);
		for (const name of inputs) {
			put(name, "after");
			expect(sourceSha256(root), name).not.toBe(before);
			put(name, "before");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("refuses to stage either binary if Cargo reports a source outside the fingerprint", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-dep-info-"));
	const workspace = path.join(root, "native/ompdesk");
	const target = path.join(workspace, "target/release");
	try {
		fs.mkdirSync(target, { recursive: true });
		fs.mkdirSync(path.join(workspace, "crates/shared/src"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "crates/shared/src/build input.txt"), "shared input");
		const deps = "target/release/bin: crates/shared/src/build\\ input.txt\n";
		for (const bin of ["ompdesk", "ompdesk-core"]) fs.writeFileSync(path.join(target, `${bin}.d`), deps);
		expect(() => checkCompilerInputs(root)).not.toThrow();
		for (const bin of ["ompdesk", "ompdesk-core"]) {
			const file = path.join(target, `${bin}.d`);
			fs.writeFileSync(file, "target/release/bin: crates/cli/tests/admission.rs\n");
			expect(() => checkCompilerInputs(root)).toThrow(
				`${bin} compiled native/ompdesk/crates/cli/tests/admission.rs`,
			);
			fs.writeFileSync(file, deps);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
