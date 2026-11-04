// Device-bound lab tokens (DPoP, RFC 9449). A lab that lists `devices` in its descriptor gets a proof with every
// request, signed by a key this computer made for that lab. A token copied off the computer is then useless without
// the key. The key is an ES256 (P-256) pair. Its private half goes to the OS credential store (Keychain, Credential
// Manager, Secret Service), or an owner-only file where there is none (or EL_KEYSTORE=file); the record beside the
// lab's sign-in keeps the public half and the lab's id for it. The lab lets the person revoke it per device.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { readJson, writeJson } from "../util.ts";

interface DeviceRecord {
	/** The lab's public address the key was made for; a key never moves between labs. */
	lab: string;
	/** The lab's id for this device, once registered. */
	id?: string;
	/** The lab revoked this key. A new one is made only after the person signs in again. */
	revoked?: boolean;
	publicJwk: JsonWebKey;
	/** Only when there is no OS credential store. */
	privateJwk?: JsonWebKey;
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SERVICE = "EnrichedLab";
const account = (jwk: JsonWebKey) => `device:${thumbprint(jwk)}`;

async function storedPrivate(publicJwk: JsonWebKey): Promise<JsonWebKey | undefined> {
	try {
		const value = await Bun.secrets.get({ service: SERVICE, name: account(publicJwk) });
		return value ? (JSON.parse(value) as JsonWebKey) : undefined;
	} catch {
		return undefined;
	}
}

export const base64url = (bytes: Uint8Array | ArrayBuffer | string): string =>
	Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).toString("base64url");

/** RFC 7638 thumbprint of an EC public key: SHA-256 over its required members in order. */
export function thumbprint(jwk: JsonWebKey): string {
	return base64url(createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

/** `ath`: the proof names the exact token it travels with. */
export const tokenHash = (token: string): string => base64url(createHash("sha256").update(token).digest());

export class DeviceKey {
	private signing?: CryptoKey;

	private constructor(
		private file: string,
		private record: DeviceRecord,
		private privateJwk: JsonWebKey | undefined,
	) {}

	/** The saved key for `lab`, or a new one (not yet registered) when there is none or it was made for another lab. */
	static async open(file: string, lab: string): Promise<DeviceKey> {
		const saved = readJson<DeviceRecord | undefined>(file, undefined);
		if (saved?.lab === lab && saved.publicJwk) {
			// A revoked key stays revoked even if its private half is gone: only a new sign-in clears it.
			const privateJwk = saved.privateJwk ?? (await storedPrivate(saved.publicJwk));
			if (privateJwk || saved.revoked) return new DeviceKey(file, saved, privateJwk);
		}
		const pair = (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as CryptoKeyPair;
		const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
		const publicJwk = { kty, crv, x, y };
		const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
		const inStore =
			process.env.EL_KEYSTORE !== "file" &&
			(await Bun.secrets.set({ service: SERVICE, name: account(publicJwk), value: JSON.stringify(privateJwk) }).then(
				() => true,
				() => false,
			));
		const record: DeviceRecord = { lab, publicJwk, ...(inStore ? {} : { privateJwk }) };
		writeJson(file, record, true);
		return new DeviceKey(file, record, privateJwk);
	}

	get id(): string | undefined {
		return this.record.id;
	}

	get revoked(): boolean {
		return this.record.revoked === true;
	}

	markRevoked(): void {
		this.record = { ...this.record, revoked: true };
		writeJson(this.file, this.record, true);
	}

	get publicJwk(): JsonWebKey {
		return this.record.publicJwk;
	}

	get thumbprint(): string {
		return thumbprint(this.record.publicJwk);
	}

	registered(id: string): void {
		this.record = { ...this.record, id };
		writeJson(this.file, this.record, true);
	}

	/** Forget the key, so the next sign-in makes and registers a new one. */
	discard(): void {
		if (existsSync(this.file)) rmSync(this.file, { force: true });
		if (!this.record.privateJwk) void Bun.secrets.delete({ service: SERVICE, name: account(this.record.publicJwk) }).catch(() => false);
	}

	/** A proof for one request. `htu` is the lab's public address and path, without query or fragment. */
	async proof(htm: string, htu: string, bearer?: string, nonce?: string): Promise<string> {
		if (!this.privateJwk) throw new Error("This computer's device key is missing from the credential store.");
		this.signing ??= await crypto.subtle.importKey("jwk", this.privateJwk, ALGORITHM, false, ["sign"]);
		const header = { typ: "dpop+jwt", alg: "ES256", jwk: this.record.publicJwk };
		const claims = {
			jti: randomUUID(),
			htm: htm.toUpperCase(),
			htu: htu.split(/[?#]/)[0],
			iat: Math.floor(Date.now() / 1000),
			...(bearer ? { ath: tokenHash(bearer) } : {}),
			...(nonce ? { nonce } : {}),
		};
		const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
		// WebCrypto's ECDSA signature is r||s, the form JWS ES256 uses.
		const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.signing, new TextEncoder().encode(input));
		return `${input}.${base64url(signature)}`;
	}
}

/** The error code in a `WWW-Authenticate: DPoP error="…"` challenge, if the lab sent one. */
export function dpopError(response: Response): string | undefined {
	const challenge = response.headers.get("www-authenticate") ?? "";
	if (!/^\s*DPoP\b/i.test(challenge)) return undefined;
	return /error="([^"]+)"/.exec(challenge)?.[1] ?? "invalid_dpop_proof";
}
