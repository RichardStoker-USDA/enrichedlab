// A port in a lab sandbox, opened on this computer: a loopback server that forwards HTTP and WebSocket traffic to the
// lab's /v1/containers/{id}/ports/{port}/ with the person's lab sign-in, so a Shiny or other web app running in the
// sandbox opens in the browser pane like a local one.
//
// The proxy adds the person's credentials to what it forwards, so it only forwards requests that come from the page it
// handed out: the Host must be this loopback address, a browser Origin must be this origin, and every request carries a
// cookie set from the one-time token in the first URL. Another site in the browser or another local program gets 403.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server, ServerWebSocket } from "bun";
import { labFetch } from "../models/http.ts";

export interface PortTarget {
	/** The lab's address for a path in the port, e.g. https://lab/v1/containers/c1/ports/3838 + path. */
	url(path: string): string;
	/** The lab's sign-in for one request (with a device proof when the lab binds tokens to devices). */
	headers(method: string, url: string): Promise<Record<string, string>>;
	ca?: string;
}

export interface OpenPort {
	/** Open this once (in the browser pane); it sets the cookie and goes to `path`. */
	url: string;
	origin: string;
	/** The app's answer to GET / through the lab, without the browser: 0 when the lab didn't answer. */
	probe(): Promise<number>;
	close(): void;
}

// Headers that describe one hop, never forwarded (RFC 9110 section 7.6.1), plus the proxy's own.
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "authorization", "dpop", "content-length", "origin"]);

interface Socket {
	upstream?: WebSocket;
	queue: (string | Uint8Array<ArrayBuffer>)[];
	path: string;
	protocols?: string;
}

export function openPort(target: PortTarget, path = "/"): OpenPort {
	const token = randomBytes(24).toString("base64url");
	let cookie = "";
	let origin = "";
	const allowed = (request: Request): boolean => {
		const url = new URL(request.url);
		const host = request.headers.get("host") ?? "";
		if (host !== url.host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
		const from = request.headers.get("origin");
		if (from && from !== origin && from !== origin.replace("127.0.0.1", "localhost")) return false;
		const sent = (request.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${cookie}=`))?.slice(cookie.length + 1) ?? "";
		return sent.length === token.length && timingSafeEqual(Buffer.from(sent), Buffer.from(token));
	};
	/** Request headers for the lab: the page's own headers minus hop headers and the proxy's cookie. */
	const forwarded = (request: Request): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [name, value] of request.headers) {
			if (HOP.has(name) || name.startsWith("sec-websocket")) continue;
			if (name === "cookie") {
				const rest = value.split(/;\s*/).filter((c) => !c.startsWith(`${cookie}=`)).join("; ");
				if (rest) out.cookie = rest;
				continue;
			}
			out[name] = value;
		}
		return out;
	};

	const server: Server<Socket> = Bun.serve<Socket, never>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, srv) {
			const url = new URL(request.url);
			// The first visit trades the one-time token for a cookie scoped to this port, then drops it from the address.
			if (url.searchParams.get("el_port") === token) {
				url.searchParams.delete("el_port");
				return new Response(null, {
					status: 303,
					headers: { location: `${url.pathname}${url.search}`, "set-cookie": `${cookie}=${token}; Path=/; HttpOnly; SameSite=Strict`, "cache-control": "no-store" },
				});
			}
			if (!allowed(request)) return new Response("This address only answers the EnrichedLab page that opened it.", { status: 403 });
			const path = `${url.pathname}${url.search}`;
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
				const protocols = request.headers.get("sec-websocket-protocol") ?? undefined;
				if (srv.upgrade(request, { data: { queue: [], path, protocols } })) return undefined;
				return new Response("WebSocket upgrade failed.", { status: 400 });
			}
			const upstream = target.url(path);
			const response = await labFetch(upstream, {
				method: request.method,
				headers: { ...forwarded(request), ...(await target.headers(request.method, upstream)) },
				body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
				redirect: "manual",
				ca: target.ca,
				...(request.body ? { duplex: "half" } : {}),
			} as RequestInit & { ca?: string }).catch((error: Error) => new Response(`The lab didn't answer: ${error.message}`, { status: 502 }));
			const headers = new Headers();
			for (const [name, value] of response.headers) if (!HOP.has(name) && name !== "content-encoding") headers.append(name, value);
			// A redirect inside the app stays on this address; a redirect to a sign-in page means the lab's sign-in ended.
			const location = response.headers.get("location");
			if (location) {
				const base = target.url("");
				const prefix = new URL(base).pathname;
				if (location.startsWith(base)) headers.set("location", location.slice(base.length) || "/");
				else if (location === prefix || location.startsWith(`${prefix}/`)) headers.set("location", location.slice(prefix.length) || "/");
				else if (/cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location)) return new Response("Your sign-in to the lab ended. Run el login, then reload.", { status: 401 });
			}
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
		},
		websocket: {
			async open(ws: ServerWebSocket<Socket>) {
				const url = target.url(ws.data.path);
				const headers = await target.headers("GET", url);
				const upstream = new WebSocket(url.replace(/^http/, "ws"), {
					headers,
					...(ws.data.protocols ? { protocols: ws.data.protocols.split(/,\s*/) } : {}),
					...(target.ca ? { tls: { ca: target.ca } } : {}),
				} as unknown as string[]);
				upstream.binaryType = "arraybuffer";
				ws.data.upstream = upstream;
				upstream.onopen = () => {
					for (const message of ws.data.queue.splice(0)) upstream.send(message);
				};
				upstream.onmessage = (event) => ws.send(event.data as string | ArrayBuffer);
				upstream.onclose = (event) => ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
				upstream.onerror = () => ws.close(1011, "The lab closed the connection.");
			},
			message(ws: ServerWebSocket<Socket>, received: string | Buffer) {
				const message = typeof received === "string" ? received : new Uint8Array(received);
				const upstream = ws.data.upstream;
				if (upstream?.readyState === WebSocket.OPEN) upstream.send(message);
				else ws.data.queue.push(message);
			},
			close(ws: ServerWebSocket<Socket>) {
				ws.data.upstream?.close();
			},
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	cookie = `el_port_${server.port}`;
	const start = path.startsWith("/") ? path : `/${path}`;
	return {
		url: `${origin}${start}${start.includes("?") ? "&" : "?"}el_port=${token}`,
		origin,
		probe: async () => {
			const url = target.url("/");
			const response = await labFetch(url, { headers: await target.headers("GET", url), redirect: "manual", ca: target.ca, signal: AbortSignal.timeout(10_000) } as RequestInit & { ca?: string }).catch(() => undefined);
			await response?.arrayBuffer().catch(() => undefined);
			return response?.status ?? 0;
		},
		close: () => server.stop(true),
	};
}
