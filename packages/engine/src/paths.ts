import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./util.ts";

/** Everything the harness keeps for one person. `EL_HOME` moves it. */
export function labHome(): string {
	if (process.env.EL_HOME) return expandHome(process.env.EL_HOME);
	const home = join(homedir(), ".el");
	const old = join(homedir(), ".enriched");
	// An engine from before the move still runs there: keep using it until it stops, then move.
	if (!existsSync(home) && existsSync(old) && engineAlive(old)) return old;
	moveOldHome(old, home);
	return home;
}

function engineAlive(home: string): boolean {
	try {
		const { pid } = JSON.parse(readFileSync(join(home, "run", "engine.json"), "utf8")) as { pid?: number };
		if (!pid) return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Releases before 0.2 kept everything in ~/.enriched. Move it once, and point saved paths at the new place. A folder
 * already at the new place wins; nothing is merged or deleted.
 */
export function moveOldHome(from: string, to: string): void {
	const settled = (dir: string) => ["config.json", "sessions", "sites.json", "credentials"].some((name) => existsSync(join(dir, name)));
	if (!settled(from) || settled(to)) return;
	try {
		if (!existsSync(to)) renameSync(from, to);
		else {
			// A new folder holding nothing of the person's (a stray run/ folder): move entries across, never over.
			for (const name of readdirSync(from)) if (!existsSync(join(to, name))) renameSync(join(from, name), join(to, name));
			if (!readdirSync(from).length) rmdirSync(from);
		}
	} catch {
		return;
	}
	for (const name of readdirSync(to)) {
		if (!name.endsWith(".json")) continue;
		const file = join(to, name);
		try {
			const text = readFileSync(file, "utf8");
			// Paths as JSON stores them: forward slashes, or Windows backslashes escaped.
			const escaped = (path: string) => JSON.stringify(path).slice(1, -1);
			const moved = text
				.split(`${from}/`).join(`${to}/`)
				.split(`${escaped(from)}${escaped("\\")}`).join(`${escaped(to)}${escaped("\\")}`)
				.split("~/.enriched/").join("~/.el/");
			if (moved !== text) writeFileSync(file, moved);
		} catch {
			// A file that can't be read stays as it is.
		}
	}
}

export function paths(home = labHome()) {
	return {
		home,
		config: join(home, "config.json"),
		sites: join(home, "sites.json"),
		ui: join(home, "ui.json"),
		credentials: join(home, "credentials"),
		sessions: join(home, "sessions"),
		run: join(home, "run"),
		engineFile: join(home, "run", "engine.json"),
		engineLock: join(home, "run", "engine.lock"),
		engineLog: join(home, "run", "engine.log"),
		canvases: join(home, "canvases"),
		bundles: join(home, "bundles"),
		memory: join(home, "memory"),
		bundleIndex: join(home, "bundles.json"),
		update: join(home, "update.json"),
	};
}

export type Paths = ReturnType<typeof paths>;

export function ensureHome(p: Paths): void {
	mkdirSync(p.home, { recursive: true, mode: 0o700 });
	mkdirSync(p.credentials, { recursive: true, mode: 0o700 });
	mkdirSync(p.sessions, { recursive: true, mode: 0o700 });
	mkdirSync(p.run, { recursive: true, mode: 0o700 });
	mkdirSync(p.canvases, { recursive: true, mode: 0o700 });
}
