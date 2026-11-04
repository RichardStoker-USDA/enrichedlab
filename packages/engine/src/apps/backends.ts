// Starting an app's backend. Three kinds speak MCP on stdio and become a client connection: "bun" (a module on the
// Bun runtime inside EnrichedLab), "command" (any MCP server the person can run) and "container" (an MCP server in a
// container). "serve" starts a web app on a free loopback port and the page is that address.
//
// Containment: bun and command backends run under the OS sandbox (writes only to the app's data folder, credential
// folders hidden, no network unless the app was allowed origins). A serve backend may also listen on loopback. A
// container is its own boundary: no network unless allowed, the app folder read-only, the data folder writable.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AppToolResult } from "@enrichedlab/protocol";
import { contained, type NetworkAccess } from "../tools/workspace.ts";
import { VERSION } from "../util.ts";
import type { AppManifest } from "./manifest.ts";
import { hasEnvironment, inEnvironment } from "./environments.ts";
import { RUNNER_SOURCE } from "./runner.ts";

export interface BackendTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** "model" and/or "app" (MCP Apps visibility); both when unset. */
	visibility: string[];
}

export interface McpBackend {
	kind: "mcp";
	tools: BackendTool[];
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AppToolResult>;
	close(): Promise<void>;
}

export interface ServedBackend {
	kind: "serve";
	url: string;
	close(): Promise<void>;
}

export type Backend = McpBackend | ServedBackend;

export interface BackendContext {
	/** The app's folder. */
	dir: string;
	/** Its writable folder. */
	dataDir: string;
	/** The project of the session that opened it, when there is one. */
	projectDir?: string;
	/** Where the runner script is written. */
	runDir: string;
	/** Where shared tools (pixi) are kept. */
	toolsDir: string;
	/** Allow network for the backend (the app was allowed origins). */
	network: boolean;
	/** Recent stderr lines, for error messages. */
	log: (line: string) => void;
}

/** The container runtime the person has, if any: Docker, Podman or nerdctl on the PATH. */
export function containerRuntime(): string | undefined {
	for (const name of ["docker", "podman", "nerdctl"]) {
		const found = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
		if (found.status === 0 && found.stdout.trim()) return found.stdout.trim().split(/\r?\n/)[0];
	}
	return undefined;
}

function runnerPath(runDir: string): string {
	const digest = createHash("sha256").update(RUNNER_SOURCE).digest("hex").slice(0, 12);
	const file = join(runDir, `app_runner_${digest}.mjs`);
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	if (!existsSync(file)) writeFileSync(file, RUNNER_SOURCE, { mode: 0o600 });
	return file;
}

function baseEnv(manifest: AppManifest, ctx: BackendContext): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "R_LIBS_USER", "R_HOME"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, APP_NAME: manifest.name, APP_VERSION: manifest.version, APP_DATA_DIR: ctx.dataDir, ...(ctx.projectDir ? { PROJECT_DIR: ctx.projectDir } : {}) };
}

async function connectStdio(command: string, args: string[], env: Record<string, string>, cwd: string, ctx: BackendContext): Promise<McpBackend> {
	const transport = new StdioClientTransport({ command, args, env, cwd, stderr: "pipe" });
	const stderr = transport.stderr;
	stderr?.on("data", (chunk: Buffer) => {
		for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) ctx.log(line);
	});
	const client = new Client({ name: "enrichedlab-app-host", version: VERSION }, { capabilities: {} });
	await client.connect(transport);
	const listed = await client.listTools();
	const tools: BackendTool[] = listed.tools.map((t) => {
		const ui = (t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui;
		return { name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema as Record<string, unknown>, visibility: ui?.visibility ?? ["model", "app"] };
	});
	return {
		kind: "mcp",
		tools,
		async call(name, args, signal) {
			const result = await client.callTool({ name, arguments: args }, { signal, timeout: 300_000 });
			return { content: (result.content ?? []) as AppToolResult["content"], structuredContent: result.structuredContent as Record<string, unknown> | undefined, isError: result.isError === true };
		},
		close: () => client.close(),
	};
}

/** A free TCP port on loopback. */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

async function waitForPort(url: string, proc: ChildProcess, ms: number): Promise<void> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (proc.exitCode !== null) throw new Error(`The app's server stopped (exit ${proc.exitCode}).`);
		try {
			await fetch(url, { signal: AbortSignal.timeout(1_000) });
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw new Error(`The app's server didn't answer at ${url} within ${Math.round(ms / 1000)} s.`);
}

function stop(proc: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (proc.exitCode !== null || !proc.pid) return resolve();
		proc.once("exit", () => resolve());
		try {
			if (process.platform === "win32") spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
			else process.kill(-proc.pid, "SIGTERM");
		} catch {
			proc.kill("SIGKILL");
		}
		setTimeout(() => {
			if (proc.exitCode === null) proc.kill("SIGKILL");
			resolve();
		}, 3_000).unref();
	});
}

/** Start the backend `manifest` declares. */
export async function startBackend(manifest: AppManifest, ctx: BackendContext): Promise<Backend> {
	const backend = manifest.backend;
	if (!backend) throw new Error("This app has no backend.");
	mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
	const env = baseEnv(manifest, ctx);
	const network: NetworkAccess = ctx.network ? "all" : "none";
	switch (backend.runtime) {
		case "bun": {
			// The compiled binary is Bun; BUN_BE_BUN makes it act as the bun command. From source, execPath is bun.
			const runner = runnerPath(ctx.runDir);
			const launch = contained(process.execPath, [runner, join(ctx.dir, backend.main)], { writable: [ctx.dataDir], readable: [runner, ctx.dir], network, server: true });
			return connectStdio(launch.file, launch.args, { ...env, BUN_BE_BUN: "1", NO_COLOR: "1" }, ctx.dir, ctx);
		}
		case "command": {
			const command = hasEnvironment(ctx.dir) ? await inEnvironment(ctx.dir, backend.command, ctx.toolsDir, ctx.log) : backend.command;
			const [program, ...args] = command;
			const launch = contained(program!, args, { writable: [ctx.dataDir, join(ctx.dir, ".pixi")], readable: [ctx.dir, ctx.toolsDir], network, server: true });
			return connectStdio(launch.file, launch.args, env, ctx.dir, ctx);
		}
		case "container": {
			const runtime = containerRuntime();
			if (!runtime) throw new Error("This app's backend runs in a container, and no container runtime (Docker, Podman, nerdctl) was found.");
			let image = backend.image;
			if (backend.build !== undefined) {
				const tag = `enrichedlab-app-${manifest.name}:${manifest.version.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
				// Async, so a long build never stalls the engine; its output goes to the app's log.
				const proc = spawn(runtime, ["build", "-q", "-t", tag, join(ctx.dir, backend.build)], { stdio: ["ignore", "pipe", "pipe"] });
				let tail = "";
				for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk: Buffer) => ((tail = (tail + chunk.toString("utf8")).slice(-2_000)), ctx.log(chunk.toString("utf8").trim())));
				const code = await new Promise<number | null>((done) => proc.on("close", done));
				if (code !== 0) throw new Error(`Building the app's image failed: ${tail.trim().slice(-600)}`);
				image = tag;
			}
			const name = `enrichedlab-app-${manifest.name}-${Date.now().toString(36)}`;
			const args = [
				"run", "-i", "--rm", "--name", name,
				"--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp",
				"--pids-limit", "512", "--memory", "4g",
				"--network", ctx.network ? "bridge" : "none",
				"-v", `${ctx.dir}:/app:ro`,
				"-v", `${ctx.dataDir}:/data`,
				"-w", "/app",
				"-e", `APP_NAME=${manifest.name}`, "-e", "APP_DATA_DIR=/data",
				image,
				...(backend.command ?? []),
			];
			const connected = await connectStdio(runtime, args, env, ctx.dir, ctx);
			// Closing the client ends the CLI; remove the container too, in case the runtime kept it.
			return { ...connected, close: async () => (await connected.close(), void spawnSync(runtime, ["rm", "-f", name], { stdio: "ignore" })) };
		}
		case "serve": {
			const port = await freePort();
			// "$PORT" in the command is the port the app serves on (it's also in the environment as PORT).
			const wanted = backend.command.map((part) => part.replaceAll("$PORT", String(port)));
			const command = hasEnvironment(ctx.dir) ? await inEnvironment(ctx.dir, wanted, ctx.toolsDir, ctx.log) : wanted;
			const [program, ...args] = command;
			// Writes go to the data folder (and the environment's own cache), so history files don't touch the app's
			// folder and its reload.
			const launch = contained(program!, args, { writable: [ctx.dataDir, join(ctx.dir, ".pixi")], readable: [ctx.dir, ctx.toolsDir], network: ctx.network ? "all" : "loopback", server: true });
			const proc = spawn(launch.file, launch.args, { cwd: ctx.dir, env: { ...env, PORT: String(port), HOST: "127.0.0.1", TMPDIR: ctx.dataDir }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
			for (const stream of [proc.stdout, proc.stderr]) stream?.on("data", (chunk: Buffer) => chunk.toString("utf8").split("\n").forEach((line) => line.trim() && ctx.log(line)));
			const url = `http://127.0.0.1:${port}${backend.path ?? "/"}`;
			try {
				await waitForPort(url, proc, 90_000);
			} catch (error) {
				await stop(proc);
				throw error;
			}
			return { kind: "serve", url, close: () => stop(proc) };
		}
	}
}
