// Updates. Each release publishes manifest.json (version, notes, and every file's size and SHA-256) and
// manifest.json.sig, an Ed25519 signature over those exact bytes. The public key is built into the binary, so a
// download that doesn't match what the release key signed is never installed, wherever it came from.
//
// The update replaces whatever this copy was installed as, without administrator rights: the macOS package into
// ~/Applications, the Windows setup into %LOCALAPPDATA%\Programs, the Linux AppImage in place, or the plain binary.

import { createHash } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import releaseKey from "../../../config/release_key.json";
import type { UpdateStatus } from "@enrichedlab/protocol";
import { readJson, VERSION, writeFileAtomic } from "./util.ts";

/** Where releases live. `ENRICHED_RELEASES` points a test or a lab mirror elsewhere. */
export const RELEASES = process.env.ENRICHED_RELEASES ?? "https://github.com/RichardStoker-USDA/enrichedlab/releases/latest/download";

export interface Manifest {
	version: string;
	published: string;
	/** True when the release fixes a security problem: surfaces say so, and the desktop installs it as it quits. */
	security?: boolean;
	notes: string[];
	files: Record<string, { sha256: string; bytes: number }>;
}

export type InstallKind = UpdateStatus["kind"];


/** How this copy was installed, from where the running program sits. */
export function installKind(exec = process.execPath, env = process.env): InstallKind {
	if (/[/\\]bun(\.exe)?$/.test(exec)) return "source";
	if (/\.app\/Contents\/Resources\/bin\/enriched$/.test(exec)) return "mac-app";
	if (/[/\\]resources[/\\]bin[/\\]enriched\.exe$/i.test(exec)) return "windows-app";
	if (env.APPIMAGE) return "appimage";
	return "binary";
}

/** The release file name for an install kind on this platform. */
export function releaseFile(kind: InstallKind, platform = process.platform, arch = process.arch): string | undefined {
	const os = platform === "win32" ? "windows" : platform;
	switch (kind) {
		case "mac-app":
			return "EnrichedLab-mac.pkg";
		case "windows-app":
			return "EnrichedLab-Setup-x64.exe";
		case "appimage":
			return `EnrichedLab-linux-${arch}.AppImage`;
		case "binary":
			return `enriched-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
		case "source":
			return undefined;
	}
}

/** True when `a` is a newer version than `b` (plain major.minor.patch). */
export function newer(a: string, b: string): boolean {
	const parts = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
	return false;
}

/** Check the manifest's signature with the built-in release key; throw if it doesn't hold. */
export async function verifyManifest(bytes: Uint8Array, signature: string, key: JsonWebKey = releaseKey as JsonWebKey): Promise<Manifest> {
	const publicKey = await crypto.subtle.importKey("jwk", key, { name: "Ed25519" }, false, ["verify"]);
	const sig = Uint8Array.from(atob(signature.trim()), (c) => c.charCodeAt(0));
	if (!(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, sig, bytes as Uint8Array<ArrayBuffer>))) {
		throw new Error("The release manifest's signature doesn't match the EnrichedLab release key.");
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
	const response = await fetch(url, { signal, redirect: "follow" });
	if (!response.ok) throw new Error(`${basename(url)}: the release server answered ${response.status}.`);
	return new Uint8Array(await response.arrayBuffer());
}

export async function latestManifest(signal = AbortSignal.timeout(20_000)): Promise<Manifest> {
	const [bytes, sig] = await Promise.all([fetchBytes(`${RELEASES}/manifest.json`, signal), fetchBytes(`${RELEASES}/manifest.json.sig`, signal)]);
	return verifyManifest(bytes, new TextDecoder().decode(sig));
}

/** What's available, checked at most once a day unless `force`. The answer is kept in `stateFile`. */
export async function checkForUpdate(stateFile: string, force = false): Promise<UpdateStatus> {
	const kind = installKind();
	const saved = readJson<UpdateStatus | undefined>(stateFile, undefined);
	if (!force && saved?.checked && saved.current === VERSION && Date.now() - Date.parse(saved.checked) < 86_400_000) return saved;
	const status: UpdateStatus = { current: VERSION, kind, checked: new Date().toISOString() };
	try {
		const manifest = await latestManifest();
		const file = releaseFile(kind);
		if (newer(manifest.version, VERSION) && file && manifest.files[file]) {
			Object.assign(status, { latest: manifest.version, security: manifest.security, notes: manifest.notes, file });
		}
	} catch (error) {
		status.error = (error as Error).message;
	}
	writeFileAtomic(stateFile, JSON.stringify(status));
	return status;
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/**
 * Download the newer release for this install, check it against the signed manifest, and install it. The desktop
 * and Windows installers finish after this process exits, so callers quit soon after.
 */
export async function applyUpdate(log: (line: string) => void = () => undefined): Promise<{ version: string; restart: boolean }> {
	const kind = installKind();
	const file = releaseFile(kind);
	if (!file) throw new Error("This copy runs from source; update it with git pull.");
	const manifest = await latestManifest();
	const entry = manifest.files[file];
	if (!newer(manifest.version, VERSION)) throw new Error(`EnrichedLab ${VERSION} is the newest release.`);
	if (!entry) throw new Error(`Release ${manifest.version} has no ${file}.`);
	const dir = join(tmpdir(), `enriched-update-${manifest.version}`);
	mkdirSync(dir, { recursive: true });
	const download = join(dir, file);
	log(`Downloading ${file} (${(entry.bytes / 1_048_576).toFixed(0)} MB)`);
	const response = await fetch(`${RELEASES.replace(/\/latest\/download$/, `/download/v${manifest.version}`)}/${file}`, { redirect: "follow" });
	if (!response.ok || !response.body) throw new Error(`${file}: the release server answered ${response.status}.`);
	await Bun.write(download, response);
	if ((await sha256File(download)) !== entry.sha256) {
		rmSync(download, { force: true });
		throw new Error(`${file} doesn't match the signed manifest; nothing was installed.`);
	}
	log(`Verified ${file} against the signed manifest`);
	switch (kind) {
		case "mac-app": {
			// The package installs into the home folder only (no administrator), replacing the app in place.
			const run = Bun.spawnSync(["/usr/sbin/installer", "-pkg", download, "-target", "CurrentUserHomeDirectory"], { stdout: "pipe", stderr: "pipe" });
			if (run.exitCode !== 0) throw new Error(`The installer failed: ${run.stderr.toString().trim().slice(-400)}`);
			return { version: manifest.version, restart: true };
		}
		case "windows-app": {
			// Per-user setup, silent; it waits for the app to close, installs, and starts it again.
			Bun.spawn([download, "/S", "--force-run"], { stdio: ["ignore", "ignore", "ignore"] }).unref();
			return { version: manifest.version, restart: true };
		}
		case "appimage":
		case "binary": {
			const target = kind === "appimage" ? process.env.APPIMAGE! : process.execPath;
			chmodSync(download, 0o755);
			// A running program can be renamed but not overwritten on Windows; move it aside first.
			const aside = `${target}.old`;
			rmSync(aside, { force: true });
			if (existsSync(target)) renameSync(target, aside);
			try {
				renameSync(download, target);
			} catch {
				// Different volumes: copy, then swap.
				await Bun.write(`${target}.new`, Bun.file(download));
				chmodSync(`${target}.new`, 0o755);
				renameSync(`${target}.new`, target);
			}
			if (process.platform !== "win32") rmSync(aside, { force: true });
			return { version: manifest.version, restart: false };
		}
	}
	throw new Error(`No updater for ${kind} in ${dirname(download)}.`);
}
