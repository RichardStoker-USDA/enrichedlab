import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./util.ts";

/** Everything the harness keeps for one person. `ENRICHED_HOME` moves it. */
export function labHome(): string {
	return process.env.ENRICHED_HOME ? expandHome(process.env.ENRICHED_HOME) : join(homedir(), ".enriched");
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
