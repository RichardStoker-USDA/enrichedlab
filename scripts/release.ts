// Build a release: the installers people download, the plain binaries, and a signed manifest the updater trusts.
//
//   bun scripts/release.ts             build everything into dist/release
//   bun scripts/release.ts --publish   then create the GitHub release v<version> with those files
//
// macOS: EnrichedLab-mac.pkg, a universal app that installs into ~/Applications with no administrator, signed with
//   the Developer ID identities in this Mac's keychain and notarized when NOTARY_PROFILE names a notarytool profile.
// Windows: EnrichedLab-Setup-x64.exe, a per-user installer (%LOCALAPPDATA%\Programs, no administrator).
// Linux: EnrichedLab-linux-<arch>.AppImage. Every platform: el-<os>-<arch> and install.sh for the terminal.
//
// The manifest is signed with the release key (RELEASE_KEY, default ~/.secrets/enriched/release_signing.jwk), read
// only at the moment of signing. Its public half is config/release_key.json, built into every binary.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { NEWS, VERSION } from "../packages/engine/src/util.ts";

const root = join(import.meta.dir, "..");
const desktop = join(root, "apps", "desktop");
const release = join(root, "dist", "release");
const built = join(root, "dist", "desktop");
const publish = process.argv.includes("--publish");
const keyFile = process.env.RELEASE_KEY ?? join(homedir(), ".secrets", "enriched", "release_signing.jwk");
const notary = process.env.NOTARY_PROFILE;

if (process.platform !== "darwin") throw new Error("Releases are built on a Mac: the macOS package needs its signing tools.");
if (!existsSync(keyFile)) throw new Error(`No release key at ${keyFile}.`);

rmSync(release, { recursive: true, force: true });
rmSync(built, { recursive: true, force: true });
mkdirSync(release, { recursive: true });

console.log("Binaries");
await $`bun ${join(root, "scripts", "build.ts")} --all`.cwd(root);
for (const name of readdirSync(join(root, "dist", "bin"))) if (name.startsWith("el-")) copyFileSync(join(root, "dist", "bin", name), join(release, name));
copyFileSync(join(root, "scripts", "install.sh"), join(release, "install.sh"));
copyFileSync(join(root, "dist", "sbom.cdx.json"), join(release, "sbom.cdx.json"));

const builder = (args: string[]) => $`npx electron-builder ${args}`.cwd(desktop).env({ ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "true" });

console.log("macOS app (universal)");
// One universal `el` in both halves of the app, so Intel and Apple silicon Macs each run their own slice.
const fat = join(root, "dist", "stage", "el-universal");
await $`lipo -create ${join(root, "dist", "stage", "mac-arm64", "el")} ${join(root, "dist", "stage", "mac-x64", "el")} -output ${fat}`;
for (const arch of ["arm64", "x64"]) copyFileSync(fat, join(root, "dist", "stage", `mac-${arch}`, "el"));
rmSync(fat);
await builder(["--mac", "dir", "--universal", "--publish", "never"]);
const app = join(built, "mac-universal", "EnrichedLab.app");
await $`codesign --verify --deep --strict ${app}`;

console.log("macOS package (installs into the home folder)");
const stage = join(root, "dist", "pkg");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "root", "Applications"), { recursive: true });
mkdirSync(join(stage, "scripts"), { recursive: true });
await $`ditto ${app} ${join(stage, "root", "Applications", "EnrichedLab.app")}`;
writeFileSync(
	join(stage, "scripts", "postinstall"),
	`#!/bin/sh
# Link the terminal command for the person installing; the package installs into their home folder only.
home="\${HOME:-$(eval echo "~$USER")}"
mkdir -p "$home/.local/bin"
ln -sf "$home/Applications/EnrichedLab.app/Contents/Resources/bin/el" "$home/.local/bin/el"
# Releases before 0.2 named the command "enriched"; drop that link when it pointed into this app.
old="$home/.local/bin/enriched"
if [ -L "$old" ] && case "$(readlink "$old")" in *EnrichedLab.app*) true ;; *) false ;; esac; then rm -f "$old"; fi
exit 0
`,
	{ mode: 0o755 },
);
writeFileSync(
	join(stage, "component.plist"),
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
	<key>BundleHasStrictIdentifier</key><true/>
	<key>BundleIsRelocatable</key><false/>
	<key>BundleIsVersionChecked</key><false/>
	<key>BundleOverwriteAction</key><string>upgrade</string>
	<key>RootRelativeBundlePath</key><string>Applications/EnrichedLab.app</string>
</dict></array></plist>
`,
);
const component = join(stage, "enrichedlab.pkg");
await $`pkgbuild --root ${join(stage, "root")} --identifier org.enrichedlab.app --version ${VERSION} --install-location / --ownership recommended --component-plist ${join(stage, "component.plist")} --scripts ${join(stage, "scripts")} ${component}`.quiet();
// pkgbuild always asks for root; a home-folder install must not, or the installer quietly writes nothing.
const expanded = join(stage, "expanded");
await $`pkgutil --expand ${component} ${expanded}`;
const info = join(expanded, "PackageInfo");
writeFileSync(info, readFileSync(info, "utf8").replace('auth="root"', 'auth="none"'));
rmSync(component);
await $`pkgutil --flatten ${expanded} ${component}`;
writeFileSync(
	join(stage, "Distribution.xml"),
	`<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
	<title>EnrichedLab</title>
	<options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
	<domains enable_currentUserHome="true" enable_localSystem="false" enable_anywhere="false"/>
	<choices-outline><line choice="default"/></choices-outline>
	<choice id="default" title="EnrichedLab"><pkg-ref id="org.enrichedlab.app"/></choice>
	<pkg-ref id="org.enrichedlab.app" version="${VERSION}" installKillProcess="EnrichedLab">#enrichedlab.pkg</pkg-ref>
</installer-gui-script>
`,
);
const pkg = join(release, "EnrichedLab-mac.pkg");
await $`productbuild --distribution ${join(stage, "Distribution.xml")} --package-path ${stage} --sign ${"Developer ID Installer"} ${pkg}`.quiet();
if (notary) {
	console.log("Notarizing the package");
	await $`xcrun notarytool submit ${pkg} --keychain-profile ${notary} --wait`;
	await $`xcrun stapler staple ${pkg}`;
} else console.warn("NOTARY_PROFILE isn't set: the package is signed but not notarized, so macOS warns on first open.");
rmSync(stage, { recursive: true, force: true });

console.log("Windows setup (per user)");
await builder(["--win", "--x64", "--publish", "never"]);
console.log("Linux AppImages");
await builder(["--linux", "AppImage", "--x64", "--publish", "never"]);
await builder(["--linux", "AppImage", "--arm64", "--publish", "never"]);
for (const name of readdirSync(built)) {
	if (/^EnrichedLab-(Setup-x64\.exe|linux-(x86_64|x64|arm64|aarch64)\.AppImage)$/.test(name)) {
		renameSync(join(built, name), join(release, name.replace("x86_64", "x64").replace("aarch64", "arm64")));
	}
}

console.log("Manifest");
const files: Record<string, { sha256: string; bytes: number }> = {};
for (const name of readdirSync(release).sort()) {
	const bytes = readFileSync(join(release, name));
	files[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: statSync(join(release, name)).size };
}
writeFileSync(join(release, "SHA256SUMS"), `${Object.entries(files).map(([name, f]) => `${f.sha256}  ${name}`).join("\n")}\n`);
const manifest = new TextEncoder().encode(
	`${JSON.stringify({ version: VERSION, published: new Date().toISOString(), security: process.argv.includes("--security") || undefined, notes: NEWS, files }, null, "\t")}\n`,
);
writeFileSync(join(release, "manifest.json"), manifest);
const signingKey = await crypto.subtle.importKey("jwk", JSON.parse(readFileSync(keyFile, "utf8")), { name: "Ed25519" }, false, ["sign"]);
const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signingKey, manifest));
writeFileSync(join(release, "manifest.json.sig"), `${btoa(String.fromCharCode(...signature))}\n`);
for (const [name, f] of Object.entries(files)) console.log(`  ${name}  ${(f.bytes / 1_048_576).toFixed(0)} MB`);

if (publish) await (await import("./publish.ts")).publish(root);
