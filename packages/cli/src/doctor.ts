// enriched doctor: what this machine has, what the engine sees, and what is missing. Configuration only; it makes no
// model request.

import { existsSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { Engine, findEngine, paths, VERSION } from "@enrichedlab/engine";
import { desktopShell } from "./open.ts";

const line = (ok: boolean | "warn", label: string, detail = "") => {
	const mark = ok === true ? "ok  " : ok === "warn" ? "note" : "fix ";
	process.stdout.write(`${mark}  ${label}${detail ? ` · ${detail}` : ""}\n`);
};

function onPath(name: string): boolean {
	const sep = process.platform === "win32" ? ";" : ":";
	const exts = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
	return (process.env.PATH ?? "").split(sep).some((dir) => dir && exts.some((e) => existsSync(join(dir, name + e))));
}

export async function doctor(): Promise<void> {
	const p = paths();
	process.stdout.write(`EnrichedLab ${VERSION} on ${platform()} ${release()} ${arch()}\n\n`);
	line(true, "Home", p.home);
	const running = await findEngine();
	line(running ? true : "warn", "Engine", running ? `port ${running.port}, pid ${running.pid}` : "not running; it starts on demand");
	line(onPath("rg") ? true : "warn", "ripgrep", onPath("rg") ? "found" : "not found; grep uses the slower built-in search");
	line(onPath("git") ? true : "warn", "git", onPath("git") ? "found" : "not found");
	const shell = desktopShell();
	line(shell ? true : "warn", "Desktop window", shell ?? "not installed; enriched app opens a browser window instead");

	const engine = new Engine({ paths: p });
	await engine.start();
	const models = engine.registry.list();
	const bySource = (s: string) => models.filter((m) => m.source === s).length;
	line(models.length > 0, "Models", models.length ? `${bySource("local")} local, ${bySource("config")} configured, ${bySource("site")} from sites` : "none: start Ollama or LM Studio, add a provider, or enriched login <site>");
	for (const [name, problem] of engine.registry.problems) line(false, `Provider ${name}`, problem);
	const preferred = engine.registry.preferred();
	if (preferred) line(true, "Default model", `${preferred.ref} (${Math.round(preferred.context / 1024)}k context)`);
	for (const site of engine.sites.list()) {
		line(site.signedIn && !site.warning ? true : "warn", `Site ${site.name}`, site.signedIn ? `${site.who} via ${site.via}; ${site.models} models, ${site.tools} tools${site.sandbox ? ", sandbox" : ""}${site.warning ? `. ${site.warning}` : ""}` : site.error ?? "not signed in");
	}
	for (const [name, problem] of engine.mcp.errors) line(false, `MCP ${name}`, problem);
	const { checkForUpdate } = await import("@enrichedlab/engine");
	const update = await checkForUpdate(p.update);
	line(update.error ? "warn" : !update.latest, "Updates", update.error ? `couldn't check: ${update.error}` : update.latest ? `${update.latest} is out${update.security ? " (security fix)" : ""}: enriched update` : `${update.current} is the newest`);
	const tools = engine.tools();
	line(true, "Tools", `${tools.length} (${tools.filter((t) => t.kind.startsWith("site")).length} from sites and MCP)`);
	await engine.stop();
}
