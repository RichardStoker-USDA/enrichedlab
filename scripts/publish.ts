// Publish a built release (dist/release) on GitHub: a draft first, each file uploaded with retries, then made public.
// The updater reads only public releases, so it never sees one with files missing. release.ts --publish calls this;
// run it alone (bun scripts/publish.ts) to finish a publish that failed partway.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { NEWS, VERSION } from "../packages/engine/src/util.ts";

const REPO = "RichardStoker-USDA/enrichedlab-harness";

export async function publish(root: string): Promise<void> {
	const release = join(root, "dist", "release");
	const tag = `v${VERSION}`;
	const notes = [
		`EnrichedLab ${VERSION}`,
		"",
		...NEWS.map((n) => `- ${n}`),
		"",
		"Download: macOS `EnrichedLab-mac.pkg`, Windows `EnrichedLab-Setup-x64.exe`, Linux `EnrichedLab-linux-<arch>.AppImage`.",
		`Terminal (macOS, Linux): \`curl -fsSL https://github.com/${REPO}/releases/latest/download/install.sh | sh\``,
	].join("\n");
	const exists = (await $`gh release view ${tag} -R ${REPO} --json tagName`.quiet().nothrow()).exitCode === 0;
	if (!exists) await $`gh release create ${tag} -R ${REPO} --draft --title ${`EnrichedLab ${VERSION}`} --notes ${notes}`.cwd(root);
	for (const name of readdirSync(release)) {
		for (let attempt = 1; ; attempt++) {
			const upload = await $`gh release upload ${tag} -R ${REPO} --clobber ${join(release, name)}`.quiet().nothrow();
			if (upload.exitCode === 0) break;
			if (attempt === 4) throw new Error(`Uploading ${name} failed: ${upload.stderr.toString().trim()}`);
			await Bun.sleep(5_000 * attempt);
		}
		console.log(`  uploaded ${name}`);
	}
	await $`gh release edit ${tag} -R ${REPO} --draft=false --latest`.quiet();
	console.log(`Published ${tag}`);
}

if (import.meta.main) await publish(join(import.meta.dir, ".."));
