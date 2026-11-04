// Sign-in to a site with OAuth 2.0 as Cloudflare Access Managed OAuth speaks it: the site names its sign-in server
// (RFC 9728), the server describes itself (RFC 8414), the engine registers once as a public client with a loopback
// redirect (RFC 7591, RFC 8252), and the person signs in in their browser with PKCE (RFC 7636) for an access token
// bound to the site (RFC 8707). Tokens are short-lived and refreshed. Nothing here logs a token or puts one in an
// error. Adapted from Gate's Pi harness (Apache 2.0, same author).

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
export interface SavedClient {
	issuer: string;
	clientId: string;
	redirectUri: string;
}

export interface Endpoints {
	resource: string;
	issuer: string;
	authorization: string;
	token: string;
	registration?: string;
}

export interface SiteCredentials {
	access: string;
	refresh: string;
	expires: number;
	clientId: string;
	tokenEndpoint: string;
	resource: string;
	[key: string]: unknown;
}

export interface LoginCallbacks {
	onAuth(info: { url: string; instructions?: string }): void;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	signal?: AbortSignal;
}

type Fetch = typeof fetch;

const SIGN_IN_WAIT_MS = 5 * 60 * 1000;
const b64url = (bytes: Buffer): string => bytes.toString("base64url");
const isLoopback = (host: string): boolean => ["127.0.0.1", "localhost", "[::1]"].includes(host);

function secureUrl(value: unknown, what: string): string {
	if (typeof value !== "string") throw new Error(`The sign-in server didn't give its ${what}.`);
	const url = new URL(value);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
		throw new Error(`The sign-in server's ${what} isn't https.`);
	}
	return url.toString();
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

async function getJson(url: string, fetchImpl: Fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetchImpl(url, { headers: { accept: "application/json" }, redirect: "error", signal });
	if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status} for ${new URL(url).pathname}.`);
	return (await response.json()) as Record<string, unknown>;
}

/** Where an issuer describes itself (RFC 8414 section 3): the well-known name goes before the issuer's own path. */
export function metadataUrl(issuer: string): string {
	const url = new URL(issuer);
	const path = url.pathname.replace(/\/+$/, "");
	return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

/** Find the site's sign-in server and its endpoints. */
export async function discover(site: string, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<Endpoints> {
	const origin = new URL(site).origin;
	const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`, fetchImpl, signal);
	if (typeof resource.resource !== "string" || !sameUrl(resource.resource, origin)) {
		throw new Error("The site's sign-in description names a different address.");
	}
	const servers = resource.authorization_servers;
	const server = secureUrl(Array.isArray(servers) ? servers[0] : undefined, "address");
	const meta = await getJson(metadataUrl(server), fetchImpl, signal);
	if (typeof meta.issuer !== "string" || !sameUrl(meta.issuer, server)) {
		throw new Error("The sign-in server's description doesn't match its address.");
	}
	const methods = meta.code_challenge_methods_supported;
	if (!Array.isArray(methods) || !methods.includes("S256")) {
		throw new Error("The sign-in server doesn't support PKCE with S256.");
	}
	return {
		resource: resource.resource,
		issuer: meta.issuer,
		authorization: secureUrl(meta.authorization_endpoint, "authorization endpoint"),
		token: secureUrl(meta.token_endpoint, "token endpoint"),
		registration: meta.registration_endpoint ? secureUrl(meta.registration_endpoint, "registration endpoint") : undefined,
	};
}

export function pkce(): { verifier: string; challenge: string } {
	const verifier = b64url(randomBytes(32));
	return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** Register as a public client that comes back to `redirectUri`. */
export async function register(
	endpoints: Endpoints,
	redirectUri: string,
	fetchImpl: Fetch = fetch,
	signal?: AbortSignal,
): Promise<string> {
	if (!endpoints.registration) throw new Error("The site's sign-in server doesn't let apps register themselves.");
	const response = await fetchImpl(endpoints.registration, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			client_name: "EnrichedLab",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		redirect: "error",
		signal,
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof body.client_id !== "string") {
		throw new Error(`The site's sign-in server didn't register this app (${response.status}).`);
	}
	return body.client_id;
}

const PAGE = (title: string, line: string): string =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title>` +
	`<body style="font:16px system-ui;margin:4rem auto;max-width:28rem;color:#022851">` +
	`<h1 style="font-size:1.4rem">${title}</h1><p>${line}</p></body>`;

export interface Listener {
	port: number;
	code(state: string, signal?: AbortSignal): Promise<string>;
	/** Everything the callback carried, once one with this state arrives. Errors are left to the caller. */
	arrival(state: string, signal?: AbortSignal): Promise<URLSearchParams>;
	close(): void;
}

interface Arrival {
	code?: string;
	error?: string;
	params: URLSearchParams;
}

/**
 * A small web server on 127.0.0.1 for the browser to come back to. Port 0 picks a free one. Only a callback that
 * carries this sign-in's state counts; anything else (another local program guessing the port, an old tab) gets an
 * error page and the wait goes on.
 */
export function listen(port: number, path = "/callback"): Promise<Listener> {
	return new Promise((resolve, reject) => {
		let expected: string | undefined;
		let settle: ((value: Arrival) => void) | undefined;
		const arrived = new Promise<Arrival>((r) => {
			settle = r;
		});
		const server: Server = createServer((request, response) => {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== path) {
				response.writeHead(404).end();
				return;
			}
			const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
			if (!expected || url.searchParams.get("state") !== expected) {
				response.writeHead(400, headers);
				response.end(PAGE("Not this sign-in", "This page isn't from the sign-in EnrichedLab is waiting for."));
				return;
			}
			const error = url.searchParams.get("error") ?? undefined;
			response.writeHead(200, headers);
			response.end(
				error
					? PAGE("Sign-in didn't finish", "Go back to EnrichedLab to see why and try again.")
					: PAGE("Signed in", "You can close this tab and go back to EnrichedLab."),
			);
			settle?.({ code: url.searchParams.get("code") ?? undefined, error, params: url.searchParams });
		});
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			const bound = typeof address === "object" && address ? address.port : port;
			const wait = (state: string, signal?: AbortSignal): Promise<Arrival> => {
				expected = state;
				const timeout = new Promise<never>((_, fail) => {
					const timer = setTimeout(() => fail(new Error("Sign-in timed out. Start it again.")), SIGN_IN_WAIT_MS);
					timer.unref();
					signal?.addEventListener("abort", () => fail(new Error("Sign-in was cancelled.")), { once: true });
				});
				return Promise.race([arrived, timeout]);
			};
			resolve({
				port: bound,
				close: () => server.close(),
				arrival: async (state, signal) => (await wait(state, signal)).params,
				code: async (state, signal) => {
					const result = await wait(state, signal);
					if (result.error) throw new Error(`Sign-in didn't finish: ${result.error}.`);
					if (!result.code) throw new Error("Sign-in came back without a code.");
					return result.code;
				},
			});
		});
	});
}

/** A code typed in by hand: the address the browser landed on, or the bare code. */
export function pastedCode(text: string, state: string): string {
	const value = text.trim();
	if (!value.includes("://")) return value;
	const url = new URL(value);
	if (url.searchParams.get("state") !== state) throw new Error("That address is from a different sign-in.");
	const code = url.searchParams.get("code");
	if (!code) throw new Error("That address has no sign-in code.");
	return code;
}

async function tokens(
	endpoint: string,
	form: Record<string, string>,
	fetchImpl: Fetch,
	signal?: AbortSignal,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		redirect: "error",
		signal,
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof body.access_token !== "string") {
		const reason = typeof body.error === "string" ? `: ${body.error}` : "";
		if (body.error === "invalid_grant") throw new Error("Your sign-in has ended. Run el login again.");
		throw new Error(`The site's sign-in server refused the token request (${response.status}${reason}).`);
	}
	return body as { access_token: string; refresh_token?: string; expires_in?: number };
}

const expiry = (seconds: unknown): number =>
	Date.now() + (typeof seconds === "number" && seconds > 0 ? seconds : 900) * 1000 - 60_000;

export interface LoginResult {
	credentials: SiteCredentials;
	client: SavedClient;
}

/** The whole browser sign-in. `saved` is the client registered last time, reused while its port is free. */
export async function login(
	site: string,
	callbacks: LoginCallbacks,
	saved?: SavedClient,
	fetchImpl: Fetch = fetch,
): Promise<LoginResult> {
	const signal = callbacks.signal;
	callbacks.onProgress?.("Finding the site's sign-in server");
	const endpoints = await discover(site, fetchImpl, signal);
	const reuse = saved && saved.issuer === endpoints.issuer ? saved : undefined;
	let listener: Listener;
	try {
		listener = await listen(reuse ? Number(new URL(reuse.redirectUri).port) : 0);
	} catch {
		listener = await listen(0);
	}
	try {
		const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
		const clientId =
			reuse && reuse.redirectUri === redirectUri ? reuse.clientId : await register(endpoints, redirectUri, fetchImpl, signal);
		const { verifier, challenge } = pkce();
		const state = b64url(randomBytes(16));
		const url = new URL(endpoints.authorization);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: redirectUri,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			resource: endpoints.resource,
		}).toString();
		callbacks.onAuth({
			url: url.toString(),
			instructions: "Sign in in your browser. If the browser is on another machine, paste the address it lands on.",
		});
		const waiting: Promise<string>[] = [listener.code(state, signal)];
		if (callbacks.onManualCodeInput) waiting.push(callbacks.onManualCodeInput().then((text) => pastedCode(text, state)));
		const code = await Promise.race(waiting);
		callbacks.onProgress?.("Finishing sign-in");
		const got = await tokens(
			endpoints.token,
			{
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: clientId,
				code_verifier: verifier,
				resource: endpoints.resource,
			},
			fetchImpl,
			signal,
		);
		if (!got.refresh_token) throw new Error("The site's sign-in server gave no refresh token.");
		return {
			credentials: {
				access: got.access_token,
				refresh: got.refresh_token,
				expires: expiry(got.expires_in),
				clientId,
				tokenEndpoint: endpoints.token,
				resource: endpoints.resource,
			},
			client: { issuer: endpoints.issuer, clientId, redirectUri },
		};
	} finally {
		listener.close();
	}
}

/** A fresh access token from the refresh token. A server that rotates refresh tokens gives a new one. */
export async function refresh(
	credentials: SiteCredentials,
	signal?: AbortSignal,
	fetchImpl: Fetch = fetch,
): Promise<SiteCredentials> {
	const got = await tokens(
		credentials.tokenEndpoint,
		{
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: credentials.clientId,
			resource: credentials.resource,
		},
		fetchImpl,
		signal,
	);
	return {
		...credentials,
		access: got.access_token,
		refresh: got.refresh_token ?? credentials.refresh,
		expires: expiry(got.expires_in),
	};
}
