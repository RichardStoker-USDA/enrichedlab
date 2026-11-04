// Device-bound lab tokens: a local lab that checks every proof the way the contract says (RFC 9449), and the client
// registering its key, signing each request for the lab's public address, retrying on a nonce or a lost registration,
// stopping on a revoked key, and revoking its key on sign-out.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thumbprint, tokenHash } from "../packages/engine/src/sites/dpop.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";

// Keys go to files here, never into this computer's real credential store.
process.env.EL_KEYSTORE = "file";
const PUBLIC = "https://lab.example.org";
const TOKEN = "lab-token";
const lab = {
	devices: new Map<string, { id: string; thumbprint: string; revoked: boolean }>(),
	jtis: new Set<string>(),
	nonce: undefined as string | undefined,
	deleted: [] as string[],
	/** Answer the next requests with this code, as Gate does for a bound or stale sign-in. */
	code: undefined as string | undefined,
};
let next = 1;

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
const refuse = (code: string) => new Response(JSON.stringify({ error: { message: code } }), { status: 401, headers: { "www-authenticate": `DPoP error="${code}"` } });

/** The proof's key thumbprint, or the error code a lab sends back. */
async function verify(request: Request, url: URL): Promise<{ thumb: string; jwk: JsonWebKey } | { code: string }> {
	const proof = request.headers.get("dpop");
	if (!proof) return { code: "device_proof_required" };
	const [h, p, signature] = proof.split(".") as [string, string, string];
	const header = decode(h) as { typ?: string; alg?: string; jwk: JsonWebKey };
	const claims = decode(p) as { htm?: string; htu?: string; ath?: string; iat?: number; jti?: string; nonce?: string };
	if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || "d" in header.jwk) return { code: "invalid_dpop_proof" };
	const key = await crypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
	const signed = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${h}.${p}`));
	const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
	const fresh = typeof claims.iat === "number" && Math.abs(Date.now() / 1000 - claims.iat) < 120;
	if (!signed || claims.htm !== request.method || claims.htu !== `${PUBLIC}${url.pathname}` || claims.ath !== tokenHash(bearer) || !fresh || !claims.jti || lab.jtis.has(claims.jti)) return { code: "invalid_dpop_proof" };
	lab.jtis.add(claims.jti);
	if (lab.nonce && claims.nonce !== lab.nonce) return { code: "use_dpop_nonce" };
	return { thumb: thumbprint(header.jwk), jwk: header.jwk };
}

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") {
			return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { devices: true, models: true }, sign_in: { kind: "key" }, policy: { device_proof: "required" } });
		}
		const proof = await verify(request, url);
		if ("code" in proof) {
			const refused = refuse(proof.code);
			if (proof.code === "use_dpop_nonce") refused.headers.set("dpop-nonce", lab.nonce!);
			return refused;
		}
		if (url.pathname === "/v1/devices" && request.method === "POST") {
			const body = (await request.json()) as { jwk?: JsonWebKey };
			if (body.jwk && thumbprint(body.jwk) !== proof.thumb) return Response.json({ error: { message: "the jwk isn't the key that signed" } }, { status: 400 });
			const device = { id: `d${next++}`, thumbprint: proof.thumb, revoked: false };
			lab.devices.set(proof.thumb, device);
			return Response.json({ ...device, current: true });
		}
		if (lab.code) return refuse(lab.code);
		const device = lab.devices.get(proof.thumb);
		if (!device) return refuse("device_unregistered");
		if (device.revoked) return refuse("device_revoked");
		if (url.pathname === "/v1/devices" && request.method === "GET") return Response.json({ data: [...lab.devices.values()].map((d) => ({ ...d, current: d === device })) });
		if (url.pathname.startsWith("/v1/devices/") && request.method === "DELETE") {
			lab.deleted.push(url.pathname.split("/").at(-1)!);
			return Response.json({ ok: true });
		}
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [{ lab: "devlab", roles: ["member"] }] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		return new Response("", { status: 404 });
	},
});
const home = mkdtempSync(join(tmpdir(), "el-dpop-"));
afterAll(() => {
	server.stop(true);
	rmSync(home, { recursive: true, force: true });
});
const file = join(home, "device_devlab.json");
const base = `http://127.0.0.1:${server.port}`;
const site = () => new GateSite({ name: "devlab", url: PUBLIC, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: `Bearer ${TOKEN}` }) }, undefined, file);
const saved = () => JSON.parse(readFileSync(file, "utf8")) as { id?: string; revoked?: boolean; privateJwk?: { d?: string } };
const me = (s: GateSite) => (s as unknown as { json(method: string, path: string): Promise<{ handle: string }> }).json("GET", "/v1/me");

describe("device-bound lab tokens", () => {
	beforeEach(() => {
		lab.nonce = undefined;
	});

	test("connect registers this computer's key, keeps it owner-only, and signs requests for the public address", async () => {
		const s = site();
		await s.connect();
		expect(s.who).toBe("pat");
		expect(saved().id).toBe("d1");
		expect(saved().privateJwk?.d).toBeString();
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		// A second connection reuses the key instead of registering another.
		await site().connect();
		expect(lab.devices.size).toBe(1);
	});

	test("el lab check proves the lab refuses proofs for another token, another address, or used twice", async () => {
		// Not connected first: the lab asks for a proof and the client loads its registered key instead of making one.
		const rows = await site().check();
		expect(lab.devices.size).toBe(1);
		const device = rows.filter((r) => r.row === "device key" || r.row.startsWith("proof "));
		expect(device.map((r) => [r.row, r.status])).toEqual([
			["device key", "pass"],
			["proof for another token", "pass"],
			["proof for another address", "pass"],
			["proof used twice", "pass"],
		]);
	});

	test("a nonce challenge is answered once with the nonce", async () => {
		const s = site();
		await s.connect();
		lab.nonce = "n-1";
		expect((await me(s)).handle).toBe("pat");
	});

	test("a lab that lost the registration gets a new key registered, and the request goes through", async () => {
		const s = site();
		await s.connect();
		lab.devices.clear();
		expect((await me(s)).handle).toBe("pat");
		expect(saved().id).toBe("d2");
	});

	test("a revoked key stops: no new key until the person signs in again", async () => {
		const s = site();
		await s.connect();
		for (const d of lab.devices.values()) d.revoked = true;
		await expect(me(s)).rejects.toThrow("revoked this computer's key");
		expect(saved().revoked).toBe(true);
		const registered = lab.devices.size;
		await expect(site().connect()).rejects.toThrow("Sign in again");
		expect(lab.devices.size).toBe(registered);
	});

	test("a sign-in bound to another key, or older than a revocation, asks for a new sign-in without retrying", async () => {
		rmSync(file, { force: true });
		const s = site();
		await s.connect();
		const before = lab.jtis.size;
		lab.code = "device_mismatch";
		await expect(me(s)).rejects.toThrow("is bound to another device key. Sign in again (el login devlab)");
		lab.code = "signin_stale";
		await expect(me(s)).rejects.toThrow("is older than a device revocation");
		lab.code = undefined;
		expect(lab.jtis.size).toBe(before + 2);
	});

	test("sign-out revokes the key at the lab and deletes it here", async () => {
		rmSync(file, { force: true });
		const s = site();
		await s.connect();
		const id = saved().id!;
		await s.forget();
		expect(lab.deleted).toContain(id);
		expect(existsSync(file)).toBe(false);
	});
});
