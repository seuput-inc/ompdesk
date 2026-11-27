import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import app from "../../package.json" with { type: "json" };
import { PRODUCT_REPO } from "../../src/shared/product-repo";
import { releaseSentence } from "../../src/shared/release-summary";

export const installedVersion = app.version;
export const availableVersion = installedVersion.replace(/\d+$/, patch => String(Number(patch) + 1));
export const availableSummary = {
	en: "Settings shows what changed beside each version number.",
	ko: "설정에서 버전 번호 옆에 변경 내용을 표시합니다.",
};

export async function installedSummary(lang: "en" | "ko"): Promise<string> {
	const changelog = await readFile("CHANGELOG.md", "utf8");
	const section = changelog.split(`\n## [${installedVersion}]`)[1]?.split("\n## ")[0];
	const [ko, en] = section?.slice(section.indexOf("\n")).split("<!-- en -->") ?? [];
	const sentence = releaseSentence((lang === "ko" ? ko : en) ?? "", lang);
	if (!sentence) throw new Error(`CHANGELOG.md has no ${lang} summary for ${installedVersion}`);
	return sentence;
}

export interface VersionSummaryFeed {
	url: string;
	publish(value: boolean): void;
	close(): Promise<void>;
}

/** Serve GitHub's release format over the updater's loopback mirror. Never complete an installer download. */
export async function versionSummaryFeed(): Promise<VersionSummaryFeed> {
	const repo = `api.github.com/repos/${PRODUCT_REPO}`;
	const size = 64 * 1024;
	const sha512 = createHash("sha512").update(Buffer.alloc(size)).digest("base64");
	const files = {
		windows: { name: "ompdesk-windows-setup.exe", size, sha512 },
		mac: { name: "ompdesk-mac-arm64.dmg", size, sha512, minimumSystemVersion: "23.0.0" },
	};
	const assets = Object.values(files).map(({ name }, i) => ({
		id: i + 1,
		name,
		size,
		url: `https://${repo}/releases/assets/${i + 1}`,
	}));
	let published = false;
	const server = createServer((request, response) => {
		if (request.url === `/${repo}`) {
			response.end(JSON.stringify({ full_name: PRODUCT_REPO }));
		} else if (published && request.url === `/${repo}/releases/latest`) {
			const tag = `v${availableVersion}`;
			const metadata = { version: availableVersion, releaseDate: "2026-11-27T00:00:00.000Z", files };
			const body = `${availableSummary.ko}\n\n---\n\n${availableSummary.en}\n\n---\n\nRequires omp **19.2.0** or newer (\`omp update\`).\n\n<!-- ompdesk-update ${JSON.stringify(metadata)} -->`;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false, assets, body }));
		} else if (published && request.url === `/${repo}/releases/assets/1`) {
			// Windows starts downloading without a click. Real progress keeps the transfer live until the capture ends.
			const byte = Buffer.alloc(1);
			response.write(byte);
			const timer = setInterval(() => response.write(byte), 5000);
			response.once("close", () => clearInterval(timer));
		} else {
			response.writeHead(404).end();
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port for the release mirror");
	return {
		url: `http://127.0.0.1:${address.port}`,
		publish(value: boolean) {
			published = value;
			if (!published) server.closeAllConnections();
		},
		async close() {
			const closed = once(server, "close");
			server.close();
			server.closeAllConnections();
			await closed;
		},
	};
}
