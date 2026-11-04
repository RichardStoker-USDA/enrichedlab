// Running the engine as a per-person background process, and finding or starting it from a surface.
//
// `<home>/run/engine.json` (owner-only) says where the engine listens and holds its token. A lock file stops two
// engines starting at once. The engine stops after 30 minutes with no surface attached and no turn running.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { EngineFile } from "@enrichedlab/protocol";
import { Engine } from "./engine.ts";
import { ensureHome, type Paths, paths as labPaths } from "./paths.ts";
import { LabServer } from "./server/server.ts";
import { readJson, sleep, VERSION, writeJson } from "./util.ts";

const IDLE_MS = 30 * 60 * 1000;

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Take the engine lock. The lock appears complete (the pid is in it before it has its name), a stale lock is moved
 * aside rather than deleted, and the winner checks again a moment later, so two starters can't both run. */
async function takeLock(p: Paths): Promise<boolean> {
	const mine = String(process.pid);
	const temp = `${p.engineLock}.${process.pid}.${randomBytes(4).toString("hex")}`;
	writeFileSync(temp, mine, { mode: 0o600 });
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				linkSync(temp, p.engineLock);
				await sleep(50);
				return readLock(p) === mine;
			} catch {
				const holder = Number(readLock(p));
				if (holder && holder !== process.pid && alive(holder)) return false;
				try {
					renameSync(p.engineLock, `${p.engineLock}.stale.${randomBytes(4).toString("hex")}`);
				} catch {
					// Someone else moved it first; try again.
				}
				for (const name of readdirSync(dirname(p.engineLock))) {
					if (name.startsWith(`${basename(p.engineLock)}.stale.`)) rmSync(join(dirname(p.engineLock), name), { force: true });
				}
			}
		}
		return false;
	} finally {
		rmSync(temp, { force: true });
	}
}

/** When the lock file was written, or now when there is none. */
function lockAge(p: Paths): number {
	try {
		return statSync(p.engineLock).mtimeMs;
	} catch {
		return Date.now();
	}
}

function readLockOwned(p: Paths): boolean {
	return readLock(p) === String(process.pid);
}

function readLock(p: Paths): string {
	try {
		return readFileSync(p.engineLock, "utf8").trim();
	} catch {
		return "";
	}
}

/** Run the engine in this process until stopped. Prints nothing secret. */
export async function serve(options: { port?: number; foreground?: boolean } = {}): Promise<void> {
	const p = labPaths();
	ensureHome(p);
	// A lock whose engine doesn't answer is stale even if its pid is alive (pids are reused after a reboot).
	// An engine starting right now holds a fresh lock before it answers, so only an older lock counts as stale.
	if (!(await takeLock(p)) && !(await findEngine(p)) && Date.now() - lockAge(p) > 30_000) {
		rmSync(p.engineLock, { force: true });
	}
	if (!readLockOwned(p) && !(await takeLock(p))) {
		const running = readJson<EngineFile | undefined>(p.engineFile, undefined);
		throw new Error(`An engine is already running${running ? ` (pid ${running.pid}, port ${running.port})` : ""}.`);
	}
	const token = randomBytes(32).toString("base64url");
	let server: LabServer | undefined;
	const engine = new Engine({ paths: p, origin: () => server?.origin ?? "http://127.0.0.1", checkUpdates: process.env.EL_UPDATES !== "off" });
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdle = (clients: number) => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		if (clients === 0 && !options.foreground) {
			idleTimer = setTimeout(function check() {
				if (engine.hasRunningSessions) idleTimer = setTimeout(check, 60_000);
				else shutdown(0);
			}, IDLE_MS);
		}
	};
	server = new LabServer({ engine, token, port: options.port, onIdleChange: armIdle });
	engine.surfaces = (sessionId, capability, op, args, signal) => server!.callSurface(sessionId, capability, op, args, signal);
	engine.windowFor = (sessionId) => server!.hasSurface(sessionId, "browser");
	server.wantSurface = (sessionId, reason) => engine.wantWindow(sessionId, reason, true);
	let stopping = false;
	const shutdown = (code: number) => {
		if (stopping) return;
		stopping = true;
		server?.close();
		void engine.stop().finally(() => {
			const current = readJson<EngineFile | undefined>(p.engineFile, undefined);
			if (current?.pid === process.pid) rmSync(p.engineFile, { force: true });
			if (readLock(p) === String(process.pid)) rmSync(p.engineLock, { force: true });
			process.exit(code);
		});
		setTimeout(() => process.exit(code), 3_000).unref();
	};
	process.on("SIGTERM", () => shutdown(0));
	process.on("SIGINT", () => shutdown(0));
	process.on("SIGHUP", () => shutdown(0));

	const port = await server.listen();
	const file: EngineFile = { pid: process.pid, port, token, version: VERSION, started: new Date().toISOString() };
	writeJson(p.engineFile, file, true);
	armIdle(0);
	// Model discovery and site sign-in happen after the door opens, so a surface can attach at once.
	engine.start().catch(() => undefined);
	if (options.foreground) process.stdout.write(`EnrichedLab engine on http://127.0.0.1:${port} (pid ${process.pid})\n`);
}

/** The running engine's file, if that engine is alive and answers. */
export async function findEngine(p: Paths = labPaths()): Promise<EngineFile | undefined> {
	const file = readJson<EngineFile | undefined>(p.engineFile, undefined);
	if (!file || !alive(file.pid)) return undefined;
	try {
		const response = await fetch(`http://127.0.0.1:${file.port}/health`, { headers: { authorization: `Bearer ${file.token}` }, signal: AbortSignal.timeout(1_500) });
		const body = (await response.json()) as { authed?: boolean; busy?: boolean };
		return body.authed ? { ...file, busy: body.busy } : undefined;
	} catch {
		return undefined;
	}
}

/** How to start this program again as an engine: the compiled binary, or the runtime plus this script. */
function selfCommand(): { file: string; args: string[] } {
	const runtime = basename(process.execPath).replace(/\.exe$/i, "");
	const compiled = runtime !== "bun" && runtime !== "node";
	if (compiled) return { file: process.execPath, args: ["serve"] };
	return { file: process.execPath, args: [process.argv[1], "serve"] };
}

/** Find the engine or start one, then return where it is. */
export async function ensureEngine(p: Paths = labPaths()): Promise<EngineFile> {
	ensureHome(p);
	const found = await findEngine(p);
	if (found && found.version === VERSION) return found;
	if (found?.busy) {
		// An engine from another version is in the middle of a turn: use it rather than cut the turn off. The next
		// start after it goes idle (or `el engine restart`) brings up this version.
		process.stderr.write(`el: engine ${found.version} is finishing a turn; using it for now.\n`);
		return found;
	}
	if (found) {
		// An engine from another version, idle: ask it to stop, then start this one.
		await stopEngine(p);
	}
	const { file, args } = selfCommand();
	const log = openSync(p.engineLog, "a", 0o600);
	const child = spawn(file, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: process.env });
	child.unref();
	closeSync(log);
	for (let waited = 0; waited < 15_000; waited += 100) {
		await sleep(100);
		const started = await findEngine(p);
		if (started) return started;
	}
	throw new Error(`The engine didn't start. Its log is at ${p.engineLog}.`);
}

export async function stopEngine(p: Paths = labPaths()): Promise<boolean> {
	const file = readJson<EngineFile | undefined>(p.engineFile, undefined);
	if (!file || !alive(file.pid)) {
		rmSync(p.engineFile, { force: true });
		return false;
	}
	try {
		process.kill(file.pid, "SIGTERM");
	} catch {
		return false;
	}
	for (let waited = 0; waited < 5_000 && alive(file.pid); waited += 100) await sleep(100);
	if (existsSync(p.engineFile) && !alive(file.pid)) rmSync(p.engineFile, { force: true });
	return true;
}
