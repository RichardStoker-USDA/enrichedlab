// Opening addresses: the default browser, a Chromium-family browser in app mode (a window without tabs), or the
// EnrichedLab desktop shell when it is installed. Nothing here needs administrator rights.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { paths } from "@enrichedlab/engine";

function run(file: string, args: string[]): boolean {
	try {
		const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
		child.on("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function onPath(name: string): string | undefined {
	const sep = process.platform === "win32" ? ";" : ":";
	for (const dir of (process.env.PATH ?? "").split(sep)) {
		if (!dir) continue;
		const full = join(dir, name);
		if (existsSync(full)) return full;
	}
	return undefined;
}

export function openBrowser(url: string): boolean {
	if (process.platform === "darwin") return run("open", [url]);
	if (process.platform === "win32") return run("rundll32", ["url.dll,FileProtocolHandler", url]);
	return run("xdg-open", [url]);
}

/** A Chromium-family browser that can open an app window, if one is installed for this person. */
function appBrowser(): string | undefined {
	const home = homedir();
	if (process.platform === "darwin") {
		const names = ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser", "Arc"];
		for (const root of ["/Applications", join(home, "Applications")]) {
			for (const name of names) {
				const exe = join(root, `${name}.app`, "Contents", "MacOS", name);
				if (existsSync(exe)) return exe;
			}
		}
		return undefined;
	}
	if (process.platform === "win32") {
		const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
		for (const root of roots) {
			for (const rel of ["Microsoft\\Edge\\Application\\msedge.exe", "Google\\Chrome\\Application\\chrome.exe"]) {
				const exe = join(root, rel);
				if (existsSync(exe)) return exe;
			}
		}
		return undefined;
	}
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
		const found = onPath(name);
		if (found) return found;
	}
	return undefined;
}

/** The desktop shell, if installed. */
export function desktopShell(): string | undefined {
	const home = homedir();
	if (process.platform === "darwin") {
		for (const app of [join(home, "Applications", "EnrichedLab.app"), "/Applications/EnrichedLab.app"]) if (existsSync(app)) return app;
		return undefined;
	}
	if (process.platform === "win32") {
		const exe = join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "EnrichedLab", "EnrichedLab.exe");
		return existsSync(exe) ? exe : undefined;
	}
	for (const path of [join(home, ".local", "bin", "EnrichedLab.AppImage"), join(home, "Applications", "EnrichedLab.AppImage")]) if (existsSync(path)) return path;
	return undefined;
}

export type OpenedWith = "desktop" | "app window" | "browser" | "none";

/**
 * A page that sends the browser on to `url`, as an owner-only file in the engine's run folder. Other people on a
 * shared computer can read a program's arguments, so a pairing address never goes on a command line: the browser is
 * given this file instead. Files from earlier opens are removed after five minutes.
 */
function forwardingPage(url: string): string {
	const dir = paths().run;
	for (const name of readdirSync(dir)) {
		const file = join(dir, name);
		if (name.startsWith("open-") && Date.now() - statSync(file).mtimeMs > 300_000) rmSync(file, { force: true });
	}
	const file = join(dir, `open-${randomBytes(8).toString("hex")}.html`);
	const target = JSON.stringify(url).replace(/</g, "\\u003c");
	writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>EnrichedLab</title><script>location.replace(${target})</script>`, { mode: 0o600 });
	return pathToFileURL(file).href;
}

/** Open the web surface the best way available. `pairUrl` signs the browser in once. */
export function openSurface(pairUrl: string, sessionId?: string, prefer?: "browser"): OpenedWith {
	const shell = prefer ? undefined : desktopShell();
	if (shell) {
		const args = sessionId ? ["--session", sessionId] : [];
		if (process.platform === "darwin" ? run("open", ["-a", shell, "--args", ...args]) : run(shell, args)) return "desktop";
	}
	const page = forwardingPage(pairUrl);
	const browser = prefer ? undefined : appBrowser();
	if (browser && run(browser, [`--app=${page}`, "--new-window"])) return "app window";
	return openBrowser(page) ? "browser" : "none";
}
