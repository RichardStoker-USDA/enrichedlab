// EnrichedLab.app for macOS: the native SwiftUI window (apps/macos) with the universal `el` engine inside, signed for
// distribution with the hardened runtime. The release script packages it; this also runs alone for a local build.
//
//   bun scripts/build_mac_app.ts                 build dist/mac/EnrichedLab.app (el from dist/stage, else built here)
//   bun scripts/build_mac_app.ts --sign "<id>"   sign with that identity (default: Developer ID Application)
//   bun scripts/build_mac_app.ts --adhoc         sign ad hoc, for a local check only
//   bun scripts/build_mac_app.ts --reuse-el      use the el binaries already in dist/stage (the release builds them first)

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { VERSION } from "../packages/engine/src/util.ts";

const root = join(import.meta.dir, "..");
const mac = join(root, "apps", "macos");
const out = join(root, "dist", "mac");
const args = process.argv.slice(2);
const adhoc = args.includes("--adhoc");
const identity = args.includes("--sign") ? args[args.indexOf("--sign") + 1]! : "Developer ID Application";

if (process.platform !== "darwin") throw new Error("The macOS app is built on a Mac.");

console.log("Swift (universal, release)");
await $`swift build -c release --arch arm64 --arch x86_64`.cwd(mac).quiet();
const products = join(mac, ".build", "out", "Products", "Release");

console.log("Engine (universal el)");
const stage = join(root, "dist", "stage");
const arm = join(stage, "mac-arm64", "el");
const intel = join(stage, "mac-x64", "el");
if (!args.includes("--reuse-el") || !existsSync(arm) || !existsSync(intel)) await $`bun ${join(root, "scripts", "build.ts")} --all`.cwd(root);
const el = join(root, "dist", "stage", "el-universal-native");
// The release merges the two into one universal binary and puts it in both places; merge here only when they're thin.
const archs = (await $`lipo -archs ${arm}`.text()).trim().split(/\s+/);
if (archs.includes("arm64") && archs.includes("x86_64")) copyFileSync(arm, el);
else await $`lipo -create ${arm} ${intel} -output ${el}`;

console.log("Bundle");
const app = join(out, "EnrichedLab.app");
rmSync(app, { recursive: true, force: true });
const contents = join(app, "Contents");
const resources = join(contents, "Resources");
mkdirSync(join(contents, "MacOS"), { recursive: true });
mkdirSync(join(resources, "bin"), { recursive: true });
copyFileSync(join(products, "EnrichedLab"), join(contents, "MacOS", "EnrichedLab"));
for (const name of readdirSync(products)) if (name.endsWith(".bundle")) await $`ditto ${join(products, name)} ${join(resources, name)}`;
copyFileSync(el, join(resources, "bin", "el"));
rmSync(el);
await $`chmod 755 ${join(resources, "bin", "el")} ${join(contents, "MacOS", "EnrichedLab")}`;

// The icon: assets/icon.png at every size macOS asks for.
const iconset = join(out, "AppIcon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
	await $`sips -z ${size} ${size} ${join(root, "assets", "icon.png")} --out ${join(iconset, `icon_${size}x${size}.png`)}`.quiet();
	await $`sips -z ${size * 2} ${size * 2} ${join(root, "assets", "icon.png")} --out ${join(iconset, `icon_${size}x${size}@2x.png`)}`.quiet();
}
await $`iconutil -c icns ${iconset} -o ${join(resources, "AppIcon.icns")}`;
rmSync(iconset, { recursive: true, force: true });

writeFileSync(
	join(contents, "Info.plist"),
	`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>org.enrichedlab.app</string>
	<key>CFBundleName</key><string>EnrichedLab</string>
	<key>CFBundleDisplayName</key><string>EnrichedLab</string>
	<key>CFBundleExecutable</key><string>EnrichedLab</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${VERSION}</string>
	<key>CFBundleVersion</key><string>${VERSION}</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>LSMinimumSystemVersion</key><string>15.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSSupportsAutomaticTermination</key><false/>
	<key>NSHumanReadableCopyright</key><string>Richard Stoker</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleURLName</key><string>EnrichedLab invite</string>
			<key>CFBundleURLSchemes</key><array><string>enrichedlab</string></array>
		</dict>
	</array>
</dict>
</plist>
`,
);

console.log(adhoc ? "Sign (ad hoc)" : `Sign (${identity})`);
const sign = adhoc ? ["--sign", "-"] : ["--sign", identity, "--timestamp"];
// The engine compiles JavaScript at run time, so `el` needs JIT; the window itself needs nothing beyond the runtime.
const engineEntitlements = join(root, "apps", "desktop", "build", "entitlements.mac.plist");
await $`codesign --force --options runtime ${sign} --entitlements ${engineEntitlements} ${join(resources, "bin", "el")}`;
for (const name of readdirSync(resources)) if (name.endsWith(".bundle")) await $`codesign --force --options runtime ${sign} ${join(resources, name)}`;
await $`codesign --force --options runtime ${sign} ${app}`;
await $`codesign --verify --deep --strict ${app}`;
console.log(`Built ${app} (${VERSION})`);
