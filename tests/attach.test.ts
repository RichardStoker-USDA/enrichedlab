// Processes in a lab sandbox over attach, and app backends that run there. The local lab here starts each attached
// process on this computer, so the frames, the MCP transport over them, and a backend copied into a stand-in sandbox
// folder are all exercised for real.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Subprocess } from "bun";
import { startBackend } from "../packages/engine/src/apps/backends.ts";
import type { AppManifest } from "../packages/engine/src/apps/manifest.ts";
import { attachSocket } from "../packages/engine/src/sites/attach.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import type { SandboxApi } from "../packages/engine/src/sites/sandbox_workspace.ts";

type Proc = Subprocess<"pipe", "pipe", "pipe">;

const lab = Bun.serve<{ proc?: Proc }, never>({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request, srv): Response | undefined {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, attach: true }, sign_in: { kind: "key" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (url.pathname === "/v1/containers/c1/attach") return srv.upgrade(request, { data: {} }) ? undefined : new Response("", { status: 400 });
		return new Response("", { status: 404 });
	},
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { argv?: string[]; workdir?: string; env?: Record<string, string>; stdin?: string; eof?: boolean; signal?: string };
			if (!ws.data.proc && frame.argv?.[0] === "busy") {
				ws.send(JSON.stringify({ error: { code: "busy", message: "no free command slots" } }));
				ws.close();
				return;
			}
			if (!ws.data.proc) {
				const proc = Bun.spawn(frame.argv!, { cwd: frame.workdir, env: { ...process.env, ...frame.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
				ws.data.proc = proc;
				const pump = async (stream: ReadableStream<Uint8Array>, name: string) => {
					for await (const chunk of stream) ws.send(JSON.stringify({ [name]: Buffer.from(chunk).toString("base64") }));
				};
				const pumped = Promise.all([pump(proc.stdout, "stdout"), pump(proc.stderr, "stderr")]);
				void proc.exited.then(async (code) => {
					await pumped;
					ws.send(JSON.stringify({ exit_code: proc.signalCode ? null : code }));
					ws.close();
				});
				return;
			}
			const proc = ws.data.proc;
			if (frame.stdin) {
				proc.stdin.write(Buffer.from(frame.stdin, "base64"));
				void proc.stdin.flush();
			}
			if (frame.eof) void proc.stdin.end();
			if (frame.signal) proc.kill(frame.signal === "KILL" ? "SIGKILL" : "SIGTERM");
		},
		close(ws) {
			ws.data.proc?.kill();
		},
	},
});
const box = mkdtempSync(join(tmpdir(), "el-attach-"));
afterAll(() => {
	lab.stop(true);
	rmSync(box, { recursive: true, force: true });
});
const base = `http://127.0.0.1:${lab.port}`;
const attachUrl = `ws://127.0.0.1:${lab.port}/v1/containers/c1/attach`;
const site = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, "c1");
const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

describe("attach", () => {
	test("stdin goes in, stdout and stderr come back, and the exit code ends it", async () => {
		await site.connect();
		const script = "let s='';for await (const c of process.stdin) s+=c; console.log('got:'+s.trim()); console.error('note'); process.exit(3);";
		const process_ = await site.attach({ argv: [process.execPath, "-e", script] });
		const out: Uint8Array[] = [];
		const err: Uint8Array[] = [];
		process_.onStdout((c) => out.push(c));
		process_.onStderr((c) => err.push(c));
		process_.write("hello\n");
		process_.end();
		expect(await process_.exit).toBe(3);
		expect([text(out).trim(), text(err).trim()]).toEqual(["got:hello", "note"]);
	});

	test("a signal stops the process and the exit code is null", async () => {
		const process_ = await attachSocket(attachUrl, { authorization: "Bearer test" }, { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"] });
		process_.signal("TERM");
		expect(await process_.exit).toBeNull();
	});
});

// The stand-in sandbox: commands run under sh with their own HOME, files are copied into the box, processes attach
// through the lab above. sh and tar make this macOS and Linux only.
const home = join(box, "home");
mkdirSync(home, { recursive: true });
const sandbox: SandboxApi = {
	title: "Dev Lab",
	run: async (command) => {
		const r = Bun.spawnSync(["sh", "-c", command], { env: { ...process.env, HOME: home } });
		return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), timedOut: false };
	},
	put: async (path) => {
		const to = join(box, basename(path));
		copyFileSync(path, to);
		return { path: to, bytes: statSync(to).size };
	},
	get: async () => {
		throw new Error("unused");
	},
	attach: (spec) => attachSocket(attachUrl, { authorization: "Bearer test" }, { ...spec, env: { ...spec.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH}`, HOME: home } }),
};

describe.skipIf(process.platform === "win32")("app backends in a lab sandbox", () => {
	test("an MCP backend is copied into the sandbox and answers from there", async () => {
		const app = join(box, "yield_app");
		mkdirSync(app, { recursive: true });
		writeFileSync(
			join(app, "backend.ts"),
			`export const tools = { where: { description: "Where it runs", async run(_args, app) { return "data at " + app.dataDir; } }, quit: { description: "Stop", async run() { setTimeout(() => process.exit(0), 50); return "bye"; } } };\n`,
		);
		const manifest = { name: "yield_app", version: "1.0.0", backend: { runtime: "bun", main: "backend.ts" } } as unknown as AppManifest;
		const lines: string[] = [];
		const backend = await startBackend(manifest, { dir: app, dataDir: join(box, "local_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: (l) => lines.push(l), sandbox, sandboxOnly: true });
		if (backend.kind !== "mcp") throw new Error("expected an MCP backend");
		expect(backend.tools.map((t) => t.name)).toEqual(["where", "quit"]);
		const result = await backend.call("where", {});
		expect(result.content[0]).toEqual({ type: "text", text: `data at ${home}/.el-apps/yield_app/data` });
		// A process that ends (or a lab closing an idle connection) shows as closed, so the host starts it again.
		expect(backend.closed).toBe(false);
		await backend.call("quit", {});
		for (let i = 0; i < 60 && !backend.closed; i++) await Bun.sleep(50);
		expect(backend.closed).toBe(true);
		await backend.close();
	});

	test("a web app backend starts in the sandbox, answers on its port, and stops on close", async () => {
		const app = join(box, "plots_app");
		mkdirSync(app, { recursive: true });
		const manifest = {
			name: "plots_app",
			version: "1.0.0",
			backend: { runtime: "serve", command: [process.execPath, "-e", "Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: () => new Response('served') })"] },
		} as unknown as AppManifest;
		let port = 0;
		const withPorts: SandboxApi = {
			...sandbox,
			openPort: async (p) => {
				port = p;
				const origin = `http://127.0.0.1:${p}`;
				return { url: `${origin}/`, origin, probe: () => fetch(`${origin}/`).then((r) => r.status, () => 0), close: () => undefined };
			},
		};
		const backend = await startBackend(manifest, { dir: app, dataDir: join(box, "local_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox: withPorts });
		if (backend.kind !== "serve") throw new Error("expected a served backend");
		expect(port).toBeGreaterThanOrEqual(20_000);
		expect(await (await fetch(backend.url)).text()).toBe("served");
		await backend.close();
		for (let i = 0; i < 50 && (await fetch(backend.url).then(() => true, () => false)); i++) await Bun.sleep(50);
		expect(await fetch(backend.url).then(() => "up", () => "down")).toBe("down");
	});

	test("a full lab says so instead of a closed connection", async () => {
		const app = join(box, "busy_app");
		mkdirSync(app, { recursive: true });
		const manifest = { name: "busy_app", version: "1.0.0", backend: { runtime: "command", command: ["busy"] } } as unknown as AppManifest;
		await expect(startBackend(manifest, { dir: app, dataDir: join(box, "busy_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox, sandboxOnly: true })).rejects.toThrow(
			"as many attached processes as it allows",
		);
	});

	test("a lab that can't attach falls back to this computer unless it keeps its data inside", async () => {
		const app = join(box, "plain_app");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(app, "backend.ts"), `export const tools = { ping: { description: "ping", async run() { return "pong"; } } };\n`);
		const manifest = { name: "plain_app", version: "1.0.0", backend: { runtime: "bun", main: "backend.ts" } } as unknown as AppManifest;
		const noAttach: SandboxApi = { ...sandbox, attach: undefined };
		const ctx = { dir: app, dataDir: join(box, "plain_data"), runDir: join(box, "run"), toolsDir: join(box, "tools"), network: false, log: () => undefined, sandbox: noAttach };
		await expect(startBackend(manifest, { ...ctx, sandboxOnly: true })).rejects.toThrow("doesn't stream sandbox processes");
		const local = await startBackend(manifest, ctx);
		if (local.kind !== "mcp") throw new Error("expected an MCP backend");
		expect((await local.call("ping", {})).content[0]).toEqual({ type: "text", text: "pong" });
		await local.close();
	});
});
