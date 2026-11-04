// Sign in with ChatGPT: a person uses their ChatGPT plan for EnrichedLab's model requests. OpenAI offers this to
// open-source apps (developers.openai.com/siwc/token-sharing-open-source). On the first sign-in to an account the app
// registers itself for that account and names this computer with a stable host id; later sign-ins reuse the issued
// client id. Requests go to the Responses API with the account's token, refreshed before it expires.
//
// Tokens live in ~/.enriched/credentials/chatgpt.json (owner-only, written whole), one record per account
// registration. They never reach a surface: surfaces see the account's label and whether plan use is on.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listen, type Listener } from "../sites/oauth.ts";
import { readJson, writeFileAtomic, writeJson } from "../util.ts";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
export const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "EnrichedLab";
/** OpenAI's example port, used when free; any port works after that. */
const PREFERRED_PORT = 1455;
const CALLBACK = "/auth/callback";
/** Refresh this long before the hour-long access token runs out. */
const REFRESH_EARLY_MS = 5 * 60_000;

export interface ChatGptAccount {
	/** The issued client id: one per account and workspace. */
	id: string;
	email?: string;
	subject: string;
	idToken?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	earliestRefresh?: number;
	scopes: string[];
	savedAt: string;
}

interface Store {
	accounts: ChatGptAccount[];
	active?: string;
	/** The one-time "You're using your ChatGPT plan" note was shown. */
	welcomed?: boolean;
}

/** What surfaces may see about an account. */
export interface AccountSummary {
	id: string;
	label: string;
	active: boolean;
	signedIn: boolean;
	plan: boolean;
}

type Fetch = typeof fetch;

const storeFile = (credentials: string) => join(credentials, "chatgpt.json");
const load = (credentials: string): Store => readJson<Store>(storeFile(credentials), { accounts: [] });
const save = (credentials: string, store: Store) => writeJson(storeFile(credentials), store, true);

/** This computer's stable, opaque id for OpenAI: made once, never a person's name or email. */
export function hostId(home: string): string {
	const file = join(home, "host_id");
	if (existsSync(file)) {
		const value = readFileSync(file, "utf8").trim();
		if (/^urn:uuid:[0-9a-f-]{36}$/.test(value)) return value;
	}
	const value = `urn:uuid:${randomUUID()}`;
	writeFileAtomic(file, `${value}\n`);
	return value;
}

export function summaries(credentials: string): AccountSummary[] {
	const store = load(credentials);
	return store.accounts.map((a) => ({
		id: a.id,
		label: a.email ?? "ChatGPT account",
		active: a.id === store.active,
		signedIn: Boolean(a.refresh),
		plan: Boolean(a.refresh) && a.scopes.includes(PLAN_SCOPE),
	}));
}

export const signedIn = (credentials: string): boolean => summaries(credentials).some((a) => a.active && a.plan);

let discovery: Promise<{ jwks_uri: string; revocation_endpoint?: string }> | undefined;
function openidConfig(fetchImpl: Fetch): Promise<{ jwks_uri: string; revocation_endpoint?: string }> {
	discovery ??= fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
		.then(async (r) => {
			if (!r.ok) throw new Error(`OpenAI's sign-in server answered ${r.status}.`);
			return (await r.json()) as { jwks_uri: string; revocation_endpoint?: string };
		})
		.catch((error) => {
			discovery = undefined;
			throw error;
		});
	return discovery;
}

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

/** Check an ID token's signature against OpenAI's published keys, and its issuer, audience, time and nonce. */
export async function verifyIdToken(token: string, clientId: string, nonce: string, fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
	const [head, body, signature] = token.split(".");
	if (!head || !body || !signature) throw new Error("ChatGPT sent a malformed ID token.");
	const header = decode(head) as { alg?: string; kid?: string };
	const claims = decode(body);
	const { jwks_uri } = await openidConfig(fetchImpl);
	const { keys } = (await (await fetchImpl(jwks_uri, { signal: AbortSignal.timeout(15_000) })).json()) as { keys: (JsonWebKey & { kid?: string })[] };
	const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
	if (!jwk) throw new Error("ChatGPT's ID token is signed with a key OpenAI doesn't publish.");
	const algorithm =
		header.alg === "RS256" ? { import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } } :
		header.alg === "ES256" ? { import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } } :
		undefined;
	if (!algorithm) throw new Error(`ChatGPT's ID token uses ${header.alg ?? "no"} signing, which EnrichedLab doesn't accept.`);
	const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"] }, algorithm.import, false, ["verify"]);
	const valid = await crypto.subtle.verify(algorithm.verify, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${head}.${body}`));
	if (!valid) throw new Error("ChatGPT's ID token signature doesn't match.");
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	const now = Date.now() / 1000;
	if (claims.iss !== ISSUER) throw new Error("The ID token isn't from OpenAI's sign-in server.");
	if (!audience.includes(clientId)) throw new Error("The ID token was issued to a different app.");
	if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("The ID token has expired.");
	if (claims.nonce !== nonce) throw new Error("The ID token belongs to a different sign-in.");
	if (typeof claims.sub !== "string" || !claims.sub) throw new Error("The ID token names no account.");
	return claims;
}

interface TokenAnswer {
	access_token?: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	earliest_refresh_at?: number;
	scope?: string;
	error?: string;
	error_description?: string;
}

async function tokenRequest(form: Record<string, string>, fetchImpl: Fetch, signal?: AbortSignal): Promise<{ status: number; body: TokenAnswer }> {
	const response = await fetchImpl(TOKEN, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		redirect: "error",
		signal: signal ?? AbortSignal.timeout(30_000),
	});
	return { status: response.status, body: (await response.json().catch(() => ({}))) as TokenAnswer };
}

const expiresAt = (seconds: unknown) => Date.now() + (typeof seconds === "number" && seconds > 0 ? seconds : 3600) * 1000;
const earliest = (at: unknown) => (typeof at === "number" && at > 0 ? (at < 1e12 ? at * 1000 : at) : undefined);

export interface SignInOptions {
	home: string;
	credentials: string;
	/** An account signed in before; omitted to add a new one. */
	account?: string;
	open(url: string): void;
	signal?: AbortSignal;
	fetchImpl?: Fetch;
}

/**
 * The browser sign-in. A new account registers EnrichedLab for itself (`dynamic_agent_client`); a known one signs in
 * with its issued client id. Returns the account and whether to show the one-time plan note.
 */
export async function signIn(options: SignInOptions): Promise<{ account: ChatGptAccount; welcome: boolean }> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const before = load(options.credentials);
	const known = options.account ? before.accounts.find((a) => a.id === options.account) : undefined;
	if (options.account && !known) throw new Error("That ChatGPT account isn't saved here.");
	let listener: Listener;
	try {
		listener = await listen(PREFERRED_PORT, CALLBACK);
	} catch {
		listener = await listen(0, CALLBACK);
	}
	try {
		const redirectUri = `http://127.0.0.1:${listener.port}${CALLBACK}`;
		const verifier = randomBytes(32).toString("base64url");
		const state = randomBytes(16).toString("base64url");
		const nonce = randomBytes(16).toString("base64url");
		const query: Record<string, string> = {
			response_type: "code",
			client_id: known?.id ?? "dynamic_agent_client",
			redirect_uri: redirectUri,
			scope: SCOPES,
			resource: RESOURCE,
			state,
			nonce,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			ext_agent_host_id: hostId(options.home),
		};
		if (!known) query.agent_name_hint = APP_NAME;
		if (known?.idToken) query.id_token_hint = known.idToken;
		if (known?.email) query.login_hint = known.email;
		options.open(`${AUTHORIZE}?${new URLSearchParams(query)}`);

		const back = await listener.arrival(state, options.signal);
		const error = back.get("error");
		if (error === "access_denied") throw new Error("The ChatGPT sign-in was declined.");
		if (error) throw new Error(`The ChatGPT sign-in didn't finish: ${back.get("error_description") ?? error}.`);
		const code = back.get("code");
		if (!code) throw new Error("ChatGPT came back without a sign-in code.");
		const issued = back.get("client_id") ?? undefined;
		let clientId: string;
		if (known) {
			if (issued && issued !== known.id) throw new Error("ChatGPT answered with a different app registration, so the sign-in stopped.");
			clientId = known.id;
		} else {
			if (!issued || issued === "dynamic_agent_client") throw new Error("ChatGPT didn't finish registering EnrichedLab. Try again.");
			clientId = issued;
		}

		const { status, body } = await tokenRequest(
			{ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE },
			fetchImpl,
			options.signal,
		);
		if (status !== 200 || !body.access_token || !body.id_token) {
			throw new Error(`OpenAI refused the sign-in (${status}${body.error ? `: ${body.error}` : ""}). Try again.`);
		}
		const claims = await verifyIdToken(body.id_token, clientId, nonce, fetchImpl);
		if (known && claims.sub !== known.subject) throw new Error("That's a different ChatGPT account from the one you picked.");
		const scopes = (body.scope ?? back.get("scope") ?? "").split(/[\s+]+/).filter(Boolean).sort();
		const account: ChatGptAccount = {
			id: clientId,
			email: typeof claims.email === "string" ? claims.email : known?.email,
			subject: claims.sub as string,
			idToken: body.id_token,
			access: body.access_token,
			refresh: body.refresh_token,
			expires: expiresAt(body.expires_in),
			earliestRefresh: earliest(body.earliest_refresh_at),
			scopes,
			savedAt: new Date().toISOString(),
		};
		// Read again: a refresh may have written while the browser was open.
		const store = load(options.credentials);
		const plan = scopes.includes(PLAN_SCOPE);
		const welcome = plan && !store.welcomed;
		save(options.credentials, {
			accounts: [...store.accounts.filter((a) => a.id !== account.id), account],
			active: account.id,
			welcomed: store.welcomed || welcome,
		});
		return { account, welcome };
	} finally {
		listener.close();
	}
}

const UNUSABLE = /^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused))$/;
const refreshing = new Map<string, Promise<ChatGptAccount>>();

async function renew(credentials: string, id: string, fetchImpl: Fetch): Promise<ChatGptAccount> {
	// Read again: another process may have refreshed the rotating token already.
	const store = load(credentials);
	const account = store.accounts.find((a) => a.id === id);
	if (!account?.refresh) throw new Error("Sign in to ChatGPT again under Model services.");
	if (account.access && (account.expires ?? 0) - Date.now() > REFRESH_EARLY_MS) return account;
	const { status, body } = await tokenRequest({ grant_type: "refresh_token", client_id: account.id, refresh_token: account.refresh, resource: RESOURCE }, fetchImpl);
	if (status !== 200 || !body.access_token) {
		const code = body.error ?? "";
		if (UNUSABLE.test(code)) {
			const ended = { ...account, access: undefined, refresh: undefined, expires: undefined };
			save(credentials, { ...store, accounts: store.accounts.map((a) => (a.id === id ? ended : a)) });
			throw new Error("Your ChatGPT sign-in has ended. Sign in again under Model services.");
		}
		if (code === "invalid_client") throw new Error("OpenAI no longer recognizes EnrichedLab's registration for this account. Sign in again to register it.");
		throw new Error(`ChatGPT's sign-in server answered ${status} while renewing the sign-in. EnrichedLab will try again.`);
	}
	const renewed: ChatGptAccount = {
		...account,
		access: body.access_token,
		refresh: body.refresh_token ?? account.refresh,
		expires: expiresAt(body.expires_in),
		earliestRefresh: earliest(body.earliest_refresh_at),
		scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean).sort() : account.scopes,
		savedAt: new Date().toISOString(),
	};
	save(credentials, { ...store, accounts: store.accounts.map((a) => (a.id === id ? renewed : a)) });
	return renewed;
}

/** The active (or named) account's access token, renewed when it's close to running out. */
export async function accessToken(credentials: string, id?: string, fetchImpl: Fetch = fetch): Promise<string> {
	const store = load(credentials);
	const account = store.accounts.find((a) => a.id === (id ?? store.active));
	if (!account?.refresh) throw new Error("Sign in to ChatGPT under Model services.");
	if (!account.scopes.includes(PLAN_SCOPE)) throw new Error("This ChatGPT sign-in doesn't allow plan use. Sign in again and allow it.");
	const fresh = account.access && (account.expires ?? 0) - Date.now() > REFRESH_EARLY_MS;
	const allowed = !account.earliestRefresh || Date.now() >= account.earliestRefresh;
	if (fresh || (!allowed && account.access && (account.expires ?? 0) > Date.now())) return account.access!;
	let pending = refreshing.get(account.id);
	if (!pending) {
		pending = renew(credentials, account.id, fetchImpl).finally(() => refreshing.delete(account.id));
		refreshing.set(account.id, pending);
	}
	return (await pending).access!;
}

/** Make a saved account the one EnrichedLab uses. */
export function useAccount(credentials: string, id: string): void {
	const store = load(credentials);
	if (!store.accounts.some((a) => a.id === id)) throw new Error("That ChatGPT account isn't saved here.");
	save(credentials, { ...store, active: id });
}

/**
 * Sign out: end the renewable session at OpenAI, then clear the tokens. The account's registration and this
 * computer's id stay, so signing in again needs no new consent. Returns whether OpenAI confirmed the revocation.
 */
export async function signOut(credentials: string, id: string, fetchImpl: Fetch = fetch): Promise<{ revoked: boolean }> {
	const store = load(credentials);
	const account = store.accounts.find((a) => a.id === id);
	if (!account) return { revoked: true };
	let revoked = !account.refresh;
	if (account.refresh) {
		for (let attempt = 0; attempt < 3 && !revoked; attempt++) {
			try {
				const { revocation_endpoint } = await openidConfig(fetchImpl);
				if (!revocation_endpoint) break;
				const response = await fetchImpl(revocation_endpoint, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({ token: account.refresh, token_type_hint: "refresh_token", client_id: account.id }).toString(),
					signal: AbortSignal.timeout(15_000),
				});
				if (response.status === 200) revoked = true;
				else if (response.status < 500) break;
			} catch {
				// A network failure: try again.
			}
			if (!revoked) await Bun.sleep(500 * 2 ** attempt);
		}
	}
	const cleared = { ...account, access: undefined, refresh: undefined, idToken: undefined, expires: undefined, earliestRefresh: undefined };
	const latest = load(credentials);
	save(credentials, { ...latest, accounts: latest.accounts.map((a) => (a.id === id ? cleared : a)), active: latest.active === id ? undefined : latest.active });
	return { revoked };
}

/** A model the signed-in account may use, from its own catalog. */
export interface PlanModel {
	id: string;
	label: string;
	context?: number;
	efforts: string[];
	defaultEffort?: string;
	vision: boolean;
}

interface CatalogEntry {
	slug?: string;
	id?: string;
	display_name?: string;
	visibility?: string;
	context_window?: number;
	default_reasoning_level?: string;
	supported_reasoning_levels?: (string | { effort?: string })[];
	input_modalities?: string[];
}

/** The account's model catalog, in OpenAI's order, keeping models meant for a picker. */
export async function planModels(token: string, fetchImpl: Fetch = fetch): Promise<PlanModel[]> {
	const response = await fetchImpl(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`ChatGPT answered ${response.status} when listing models.`);
	const body = (await response.json()) as { models?: CatalogEntry[]; data?: CatalogEntry[] };
	return (body.models ?? body.data ?? [])
		.filter((m) => (m.slug ?? m.id) && (m.visibility === undefined || m.visibility === "list"))
		.map((m) => {
			const levels = (m.supported_reasoning_levels ?? []).map((l) => (typeof l === "string" ? l : l.effort)).filter((l): l is string => Boolean(l));
			return {
				id: (m.slug ?? m.id)!,
				label: m.display_name ?? (m.slug ?? m.id)!,
				context: m.context_window,
				efforts: levels.length ? levels : ["low", "medium", "high"],
				defaultEffort: m.default_reasoning_level,
				vision: m.input_modalities ? m.input_modalities.includes("image") : true,
			};
		});
}
