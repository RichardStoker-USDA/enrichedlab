// The engine's door: HTTP and a WebSocket on 127.0.0.1 only.
//
//   /rpc            WebSocket, JSON-RPC 2.0 (Lab protocol). Bearer token, or the session cookie from a pairing.
//   /pair/<code>    a one-time code from `enriched app` becomes an HttpOnly, SameSite=Strict cookie, then a redirect
//   /               the web surface (the desktop shell loads the same page)
//   /canvas/<id>    a canvas, served with a sandbox policy so its scripts get an opaque origin
//
// Every request must name this listener in Host (blocks DNS rebinding). Browser requests must come from this origin.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ErrorCodes, type Method, type Notification, type Notifications, type RpcRequest, type SurfaceAnswer } from "@enrichedlab/protocol";
import { sdkFiles } from "../apps/sdk.ts";
import { type Engine, RpcError } from "../engine.ts";
import { errorText, redact } from "../util.ts";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
};

type Asset = { type: string; body: Buffer };

/** The built web surface: embedded in a compiled binary, or read from packages/web/dist when running from source. */
async function loadAssets(): Promise<(path: string) => Asset | undefined> {
	try {
		// @ts-ignore The build writes this file; running from source falls back to packages/web/dist.
		const mod = (await import("./ui_assets.gen.ts")) as { assets: Record<string, { type: string; data: string }> };
		const cache = new Map<string, Asset>();
		return (path) => {
			const hit = mod.assets[path];
			if (!hit) return undefined;
			let asset = cache.get(path);
			if (!asset) cache.set(path, (asset = { type: hit.type, body: Buffer.from(hit.data, "base64") }));
			return asset;
		};
	} catch {
		const dist = join(import.meta.dir, "..", "..", "..", "web", "dist");
		return (path) => {
			const file = normalize(join(dist, path));
			if (!file.startsWith(dist) || !existsSync(file)) return undefined;
			try {
				return { type: MIME[extname(file)] ?? "application/octet-stream", body: readFileSync(file) };
			} catch {
				return undefined;
			}
		};
	}
}

interface Client {
	ws: WebSocket;
	name: string;
	sessions: Set<string>;
	/** Terminals this client opened: only it sees their output or types into them, and they close with it. */
	terms: Set<string>;
	/** What it can do for the engine, from hello (the desktop window: "browser"). */
	capabilities: Set<string>;
}

const SESSION_SCOPED = new Set<Notification>(["session.event", "session.delta", "session.status", "permission.request", "permission.settled", "surface.wanted"]);

export interface ServerOptions {
	engine: Engine;
	token: string;
	port?: number;
	onIdleChange?: (clients: number) => void;
}

export class LabServer {
	private server?: Server;
	private wss = new WebSocketServer({
		noServer: true,
		maxPayload: 64 * 1024 * 1024,
		handleProtocols: (protocols) => (protocols.has("lab") ? "lab" : false),
	});
	private clients = new Set<Client>();
	/** What a paired browser page holds in localStorage. Storage is scoped to scheme, host and port, so a page on
	 * another loopback port can't read it; a cookie on 127.0.0.1 would be sent to every port. */
	private browserKey = randomBytes(32).toString("base64url");
	private pairCodes = new Map<string, { next: string; expires: number }>();
	port = 0;
	private assets: (path: string) => Asset | undefined = () => undefined;

	constructor(private options: ServerOptions) {}

	get origin(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	async listen(): Promise<number> {
		this.assets = await loadAssets();
		this.server = createServer((req, res) => {
			this.http(req, res).catch((error) => {
				if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
				res.end(redact(errorText(error)));
			});
		});
		this.server.on("upgrade", (req, socket, head) => {
			if (!this.hostOk(req) || !this.originOk(req) || new URL(req.url ?? "/", "http://x").pathname !== "/rpc" || !this.authed(req)) {
				socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
				socket.destroy();
				return;
			}
			this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req));
		});
		this.options.engine.onNotify((name, params, sessionId) => this.broadcast(name, params, sessionId));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.options.port ?? 0, "127.0.0.1", () => resolve());
		});
		const address = this.server.address();
		this.port = typeof address === "object" && address ? address.port : 0;
		return this.port;
	}

	close(): void {
		for (const client of this.clients) client.ws.close(1001, "engine stopping");
		this.server?.close();
	}

	/** A one-time link that hands a browser the page key, good for two minutes. */
	pair(next = "/"): string {
		const code = randomBytes(18).toString("base64url");
		this.pairCodes.set(code, { next: next.startsWith("/") ? next : "/", expires: Date.now() + 120_000 });
		return `${this.origin}/pair/${code}`;
	}

	private hostOk(req: IncomingMessage): boolean {
		const host = req.headers.host ?? "";
		return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
	}

	private originOk(req: IncomingMessage): boolean {
		const origin = req.headers.origin;
		return !origin || origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
	}

	private same(a: string, b: string): boolean {
		const x = Buffer.from(a);
		const y = Buffer.from(b);
		return x.length === y.length && timingSafeEqual(x, y);
	}

	/** The terminal and desktop shell send the engine token; a paired page sends its key as a WebSocket subprotocol
	 * ("lab", "key.<key>"), from its own origin. */
	private authed(req: IncomingMessage): boolean {
		const auth = req.headers.authorization;
		if (auth?.startsWith("Bearer ") && this.same(auth.slice(7), this.options.token)) return true;
		const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
		const key = offered.find((p) => p.startsWith("key."))?.slice(4);
		return Boolean(key && req.headers.origin && this.same(key, this.browserKey));
	}

	private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const security = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" };
		if (!this.hostOk(req)) {
			res.writeHead(421, security).end();
			return;
		}
		const url = new URL(req.url ?? "/", this.origin);
		const path = url.pathname;

		if (path === "/health") {
			const authed = this.authed(req);
			res.writeHead(200, { ...security, "content-type": "application/json" }).end(JSON.stringify({ ok: true, authed, ...(authed ? { busy: this.options.engine.hasRunningSessions } : {}) }));
			return;
		}
		if (path === "/api/pair" && req.method === "POST") {
			// The desktop shell holds the engine token (owner-only file) and trades it for a one-time browser link.
			const auth = req.headers.authorization;
			if (!auth?.startsWith("Bearer ") || !this.same(auth.slice(7), this.options.token)) {
				res.writeHead(401, security).end();
				return;
			}
			const next = url.searchParams.get("next") ?? "/";
			res.writeHead(200, { ...security, "content-type": "application/json" }).end(JSON.stringify({ url: this.pair(next) }));
			return;
		}
		if (path.startsWith("/pair/")) {
			const entry = this.pairCodes.get(path.slice(6));
			this.pairCodes.delete(path.slice(6));
			if (!entry || entry.expires < Date.now()) {
				res.writeHead(410, { ...security, "content-type": "text/html; charset=utf-8" }).end(page("This link has expired", "Run <code>enriched app</code> again to open EnrichedLab."));
				return;
			}
			// Clear any cookie an older version set, store the key for this origin, then go to the app.
			const nonce = randomBytes(16).toString("base64");
			const script = `try{localStorage.setItem("lab.key",${JSON.stringify(this.browserKey)})}catch(e){}location.replace(${JSON.stringify(entry.next)})`;
			res.writeHead(200, {
				...security,
				"content-type": "text/html; charset=utf-8",
				"set-cookie": "lab_session=; Max-Age=0; Path=/",
				"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'`,
			}).end(`<!doctype html><meta charset="utf-8"><title>EnrichedLab</title><script nonce="${nonce}">${script}</script>`);
			return;
		}
		const canvasEvents = /^\/canvas\/(c[0-9a-z]+)\/events$/.exec(path);
		if (canvasEvents) {
			const stop = this.options.engine.canvas.watch(canvasEvents[1], url.searchParams.get("k") ?? "", (version) => res.write(`data: ${version}\n\n`));
			if (!stop) {
				res.writeHead(404, security).end();
				return;
			}
			res.writeHead(200, { ...security, "content-type": "text/event-stream", "access-control-allow-origin": "*" });
			res.write(": watching\n\n");
			const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
			req.on("close", () => {
				clearInterval(ping);
				stop();
			});
			return;
		}
		// App pages: /apps/<token>/<path>. The token, minted when a surface opens the app, is the capability; pages get
		// an opaque origin from their CSP and reach the host only through the surface's MCP Apps bridge.
		const appFile = /^\/apps\/([A-Za-z0-9_-]{20,40})\/(.+)$/.exec(path);
		if (appFile) {
			let rel: string;
			try {
				rel = decodeURIComponent(appFile[2]!);
			} catch {
				res.writeHead(400, security).end();
				return;
			}
			const file = this.options.engine.apps.file(appFile[1]!, rel);
			if (!file) {
				res.writeHead(404, security).end();
				return;
			}
			res.writeHead(200, { ...security, ...file.headers }).end(file.body);
			return;
		}
		const sdk = /^\/app-sdk\/(lab|app)\.js$/.exec(path);
		if (sdk) {
			const files = await sdkFiles().catch(() => undefined);
			const body = files?.[`${sdk[1]}.js`];
			if (!body) {
				res.writeHead(503, security).end();
				return;
			}
			res.writeHead(200, { ...security, "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-cache" }).end(body);
			return;
		}
		const canvas = /^\/canvas\/(c[0-9a-z]+)$/.exec(path);
		if (canvas) {
			const html = this.options.engine.canvas.page(canvas[1], url.searchParams.get("k") ?? "");
			if (!html) {
				res.writeHead(404, security).end();
				return;
			}
			res.writeHead(200, {
				...security,
				"content-type": "text/html; charset=utf-8",
				// Model-written content: an opaque origin, scripts allowed, no access to the engine or its cookie.
				"content-security-policy": this.options.engine.canvas.sealed(canvas[1])
					? "sandbox allow-scripts; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:"
					: "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
				"cross-origin-resource-policy": "same-origin",
			}).end(html);
			return;
		}
		const asset = this.assets(path === "/" || !extname(path) ? "/index.html" : path);
		if (!asset) {
			res.writeHead(404, security).end();
			return;
		}
		const immutable = path.startsWith("/assets/");
		res.writeHead(200, {
			...security,
			"content-type": asset.type,
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-store",
			"x-frame-options": "DENY",
			"content-security-policy":
				"default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-src 'self' http://localhost:* http://127.0.0.1:* https:; frame-ancestors 'none'",
		}).end(asset.body);
	}

	private attach(ws: WebSocket, req: IncomingMessage): void {
		const client: Client = { ws, name: String(req.headers["user-agent"] ?? "surface").slice(0, 60), sessions: new Set(), terms: new Set(), capabilities: new Set() };
		this.clients.add(client);
		this.options.onIdleChange?.(this.clients.size);
		ws.on("message", (data) => void this.message(client, data.toString()));
		ws.on("close", () => {
			this.clients.delete(client);
			for (const call of this.surfaceCalls.values()) if (call.client === client) call.reject(new Error("The window closed."));
			for (const id of client.sessions) this.releaseIfUnwatched(id);
			for (const termId of client.terms) void this.options.engine.handle("term.close", { termId }).catch(() => undefined);
			this.options.onIdleChange?.(this.clients.size);
		});
		ws.on("error", () => undefined);
	}

	private releaseIfUnwatched(id: string): void {
		if (![...this.clients].some((c) => c.sessions.has(id))) this.options.engine.release(id);
	}

	private send(client: Client, payload: unknown): void {
		if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
	}

	private async message(client: Client, text: string): Promise<void> {
		let request: RpcRequest;
		try {
			request = JSON.parse(text);
		} catch {
			this.send(client, { jsonrpc: "2.0", id: null, error: { code: ErrorCodes.parse, message: "Not JSON." } });
			return;
		}
		if (request.id === undefined || typeof request.method !== "string") return;
		try {
			const params = (request.params ?? {}) as Record<string, unknown>;
			let result: unknown;
			if (request.method === "engine.pair") result = { url: this.pair(typeof params.next === "string" ? params.next : "/") };
			else if (request.method === "surface.reply") {
				const pending = this.surfaceCalls.get(String(params.callId));
				if (!pending || pending.client !== client) throw new RpcError(-32602, "No such call.");
				this.surfaceCalls.delete(String(params.callId));
				if (typeof params.error === "string") pending.reject(new Error(params.error));
				else pending.resolve(params.result as SurfaceAnswer);
				result = { ok: true };
			}
			else if (request.method === "engine.stop") {
				result = { ok: true };
				setTimeout(() => process.emit("SIGTERM"), 50);
			} else {
				// Subscribe before the snapshot is taken, so nothing emitted while it loads is missed; the client drops
				// events it already has by id.
				if (request.method === "session.open") {
					client.sessions.add(String(params.sessionId));
					this.options.engine.watched(String(params.sessionId));
				}
				if (/^term\.(input|resize|close)$/.test(request.method) && !client.terms.has(String(params.termId))) throw new RpcError(-32602, "That terminal belongs to another window.");
				if (request.method === "hello" && Array.isArray(params.capabilities)) {
					client.capabilities = new Set(params.capabilities.filter((c): c is string => typeof c === "string").slice(0, 16));
				}
				result = await this.options.engine.handle(request.method as Method, params as never);
				if (request.method === "session.create") client.sessions.add((result as { id: string }).id);
				if (request.method === "term.open") client.terms.add((result as { termId: string }).termId);
				if (request.method === "term.close") client.terms.delete(String(params.termId));
				if (request.method === "session.close") {
					client.sessions.delete(String(params.sessionId));
					this.releaseIfUnwatched(String(params.sessionId));
				}
			}
			this.send(client, { jsonrpc: "2.0", id: request.id, result });
		} catch (error) {
			const code = error instanceof RpcError ? error.code : ErrorCodes.internal;
			this.send(client, { jsonrpc: "2.0", id: request.id, error: { code, message: redact(errorText(error)) } });
		}
	}

	private surfaceCalls = new Map<string, { client: Client; resolve: (answer: SurfaceAnswer) => void; reject: (error: Error) => void }>();

	private surfaceFor(sessionId: string, capability: string): Client | undefined {
		return [...this.clients].find((c) => c.sessions.has(sessionId) && c.capabilities.has(capability) && c.ws.readyState === WebSocket.OPEN);
	}

	/** Whether a window that can `capability` shows this session. */
	hasSurface(sessionId: string, capability: string): boolean {
		return Boolean(this.surfaceFor(sessionId, capability));
	}

	/** Called when a call needs a window and none shows the session: the engine asks the terminal to open one. */
	wantSurface?: (sessionId: string, reason: string) => void;

	/** Ask one window that shows this session and can `capability` to act, and wait for its answer. With no window,
	 * ask for one and give it 30 seconds to open. */
	async callSurface(sessionId: string, capability: string, op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<SurfaceAnswer> {
		let client = this.surfaceFor(sessionId, capability);
		if (!client) {
			this.wantSurface?.(sessionId, `the ${capability}`);
			for (let waited = 0; !client && waited < 30_000 && !signal.aborted; waited += 250) {
				await new Promise((r) => setTimeout(r, 250));
				client = this.surfaceFor(sessionId, capability);
			}
		}
		if (!client) throw new Error(`No EnrichedLab window has this session open; open it there (enriched app) to use the ${capability}.`);
		const target = client;
		const callId = randomBytes(9).toString("base64url");
		return new Promise<SurfaceAnswer>((resolve, reject) => {
			const timer = setTimeout(() => settle(() => reject(new Error(`The window didn't answer within two minutes.`))), 120_000);
			const settle = (fn: () => void) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				this.surfaceCalls.delete(callId);
				fn();
			};
			const abort = () => settle(() => reject(new Error("Stopped.")));
			signal.addEventListener("abort", abort, { once: true });
			this.surfaceCalls.set(callId, { client: target, resolve: (a) => settle(() => resolve(a)), reject: (e) => settle(() => reject(e)) });
			this.send(target, { jsonrpc: "2.0", method: "surface.call", params: { callId, sessionId, capability, op, args } });
		});
	}

	private broadcast<N extends Notification>(name: N, params: Notifications[N], sessionId?: string): void {
		const payload = JSON.stringify({ jsonrpc: "2.0", method: name, params });
		const termId = name === "term.output" || name === "term.exit" ? (params as { termId: string }).termId : undefined;
		for (const client of this.clients) {
			if (SESSION_SCOPED.has(name) && sessionId && !client.sessions.has(sessionId)) continue;
			if (termId && !client.terms.has(termId)) continue;
			if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
		}
		if (name === "term.exit") for (const client of this.clients) client.terms.delete(termId!);
	}
}

function page(title: string, line: string): string {
	return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:18vh auto;max-width:30rem;padding:0 24px;color:#022851;background:#fff}@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#000}}code{font:14px ui-monospace,monospace}</style><h1 style="font-size:1.35rem;font-weight:600">${title}</h1><p>${line}</p>`;
}
