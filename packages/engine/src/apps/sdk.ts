// The scripts apps import from the engine: /app-sdk/lab.js (EnrichedLab's helpers, bundled from
// packages/web/src/sdk/lab.ts) and /app-sdk/app.js (the MCP Apps SDK as published). A compiled binary carries both,
// written by scripts/build.ts; from source they are bundled on first use.

import { readFileSync } from "node:fs";
import { join } from "node:path";

let files: Promise<Record<string, string>> | undefined;

/** Bundle the app scripts. scripts/build.ts calls this to embed them. */
export async function buildSdk(): Promise<Record<string, string>> {
	const entry = join(import.meta.dir, "..", "..", "..", "web", "src", "sdk", "lab.ts");
	const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: true });
	if (!built.success || !built.outputs[0]) throw new Error(`Bundling the app SDK failed: ${built.logs.map(String).join("\n")}`);
	const raw = readFileSync(Bun.resolveSync("@modelcontextprotocol/ext-apps/app-with-deps", join(import.meta.dir, "..", "..", "..", "web")), "utf8");
	return { "lab.js": await built.outputs[0].text(), "app.js": raw };
}

export function sdkFiles(): Promise<Record<string, string>> {
	files ??= (async () => {
		try {
			// @ts-ignore scripts/build.ts writes this file; running from source bundles instead.
			return ((await import("./app_sdk.gen.ts")) as { files: Record<string, string> }).files;
		} catch {
			return buildSdk();
		}
	})();
	return files;
}
