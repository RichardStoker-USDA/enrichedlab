// App packages: one file to share an app. `el app pack <folder>` writes <name>-<version>.labapp, a gzipped tar
// of the app's files plus .lab/lock.json: every file's SHA-256, signed with the person's Ed25519 key (made on first
// pack, kept in ~/.el/keys). `el app add <file>` checks every hash and the signature, refuses a signer it
// doesn't know unless told to trust it, and installs to ~/.el/apps/<name>. Nothing in a package runs at
// install; the app asks for its permissions when it first opens.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import type { Paths } from "../paths.ts";
import { readJson, writeJson } from "../util.ts";
import { APP_NAME, readManifest } from "./manifest.ts";

const LOCK = ".lab/lock.json";
const MAX_TOTAL = 200 * 1024 * 1024;
const SKIP = /(^|\/)(\.git|node_modules|\.DS_Store|\.lab)(\/|$)/;

interface ArchiveLike {
	bytes(): Promise<Uint8Array>;
	files(): Promise<Map<string, Blob>>;
}
const Archive = (Bun as unknown as { Archive: new (input: Record<string, string | Uint8Array> | Uint8Array, options?: { compress?: "gzip" }) => ArchiveLike }).Archive;

export interface Lock {
	format: 1;
	name: string;
	version: string;
	created: string;
	files: Record<string, string>;
	signer?: { publicKey: string; fingerprint: string; signature: string };
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const fingerprintOf = (publicKey: Uint8Array) => sha256(publicKey).slice(0, 16).match(/.{4}/g)!.join(" ");

/** The lock without its signature, in a fixed key order: what gets signed. */
function signedBytes(lock: Lock): Uint8Array<ArrayBuffer> {
	const files = Object.fromEntries(Object.entries(lock.files).sort(([a], [b]) => (a < b ? -1 : 1)));
	return new TextEncoder().encode(JSON.stringify({ format: lock.format, name: lock.name, version: lock.version, created: lock.created, files, publicKey: lock.signer?.publicKey ?? null }));
}

/** The person's signing key, made on first use. The private half never leaves ~/.el/keys (mode 600). */
async function signingKey(p: Paths): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
	const dir = join(p.home, "keys");
	const file = join(dir, "app_signing.jwk");
	if (!existsSync(file)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as CryptoKeyPair;
		writeFileSync(file, JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)), { mode: 0o600 });
	}
	const jwk = JSON.parse(readFileSync(file, "utf8")) as JsonWebKey;
	const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
	const publicKey = Buffer.from(jwk.x!, "base64url");
	return { privateKey, publicKey: new Uint8Array(publicKey) };
}

/** This person's own fingerprint, which their installs always trust. */
export async function ownFingerprint(p: Paths): Promise<string> {
	return fingerprintOf((await signingKey(p)).publicKey);
}

function walk(root: string, dir = root, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const rel = relative(root, full).split(sep).join("/");
		if (SKIP.test(rel)) continue;
		const stat = statSync(full);
		if (stat.isDirectory()) walk(root, full, out);
		else if (stat.isFile()) out.push(rel);
	}
	return out;
}

/** Pack an app folder into `<out>/<name>-<version>.labapp`, signed. */
export async function packApp(p: Paths, dir: string, out: string): Promise<{ file: string; files: number; bytes: number; fingerprint: string }> {
	const manifest = readManifest(dir);
	const entries: Record<string, Uint8Array> = {};
	const lock: Lock = { format: 1, name: manifest.name, version: manifest.version, created: new Date().toISOString(), files: {} };
	let total = 0;
	for (const rel of walk(dir)) {
		const data = new Uint8Array(readFileSync(join(dir, rel)));
		total += data.length;
		if (total > MAX_TOTAL) throw new Error("The app is over 200 MB; keep large data out of the app's folder.");
		entries[rel] = data;
		lock.files[rel] = sha256(data);
	}
	const key = await signingKey(p);
	lock.signer = { publicKey: Buffer.from(key.publicKey).toString("base64"), fingerprint: fingerprintOf(key.publicKey), signature: "" };
	const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, signedBytes(lock));
	lock.signer.signature = Buffer.from(signature).toString("base64");
	entries[LOCK] = new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`);
	const bytes = await new Archive(entries, { compress: "gzip" }).bytes();
	mkdirSync(out, { recursive: true });
	const file = join(out, `${manifest.name}-${manifest.version.replace(/[^a-zA-Z0-9._-]/g, "-")}.labapp`);
	writeFileSync(file, bytes);
	return { file, files: Object.keys(lock.files).length, bytes: bytes.length, fingerprint: lock.signer.fingerprint };
}

interface Trusted {
	[fingerprint: string]: { publicKey: string; added: string };
}

/** Open a package, check it fully, and install it. `trust` accepts a signer this person hasn't trusted before. */
export async function installApp(p: Paths, file: string, options: { trust?: boolean } = {}): Promise<{ name: string; version: string; dir: string; fingerprint: string; newSigner: boolean }> {
	const archive = new Archive(new Uint8Array(readFileSync(file)));
	const files = await archive.files();
	const lockBlob = files.get(LOCK);
	if (!lockBlob) throw new Error("This isn't an app package: it has no .lab/lock.json.");
	const lock = JSON.parse(await lockBlob.text()) as Lock;
	if (lock.format !== 1 || !APP_NAME.test(lock.name)) throw new Error("The package's lock is damaged.");

	// Every file listed, every file present, every hash right, and nothing extra.
	const listed = Object.keys(lock.files).sort();
	const present = [...files.keys()].filter((k) => k !== LOCK && !k.endsWith("/")).sort();
	if (listed.join("\n") !== present.join("\n")) throw new Error("The package's files don't match its lock.");
	const contents: Record<string, Uint8Array> = {};
	for (const rel of listed) {
		const clean = normalize(rel).replaceAll("\\", "/");
		if (clean !== rel || rel.startsWith("/") || rel.split("/").includes("..") || /^[a-z]:/i.test(rel)) throw new Error(`The package has an unsafe path: ${rel}`);
		const data = new Uint8Array(await files.get(rel)!.arrayBuffer());
		if (sha256(data) !== lock.files[rel]) throw new Error(`${rel} doesn't match its hash; the package was changed after it was signed.`);
		contents[rel] = data;
	}

	// The signature, and whether this person trusts the signer.
	if (!lock.signer) throw new Error("The package isn't signed.");
	const publicKey: Uint8Array<ArrayBuffer> = new Uint8Array(Buffer.from(lock.signer.publicKey, "base64"));
	const fingerprint = fingerprintOf(publicKey);
	if (fingerprint !== lock.signer.fingerprint) throw new Error("The package's signer fingerprint is wrong.");
	const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
	const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(Buffer.from(lock.signer.signature, "base64")), signedBytes(lock));
	if (!valid) throw new Error("The package's signature doesn't verify.");
	const trustFile = join(p.home, "trusted_signers.json");
	const trusted = readJson<Trusted>(trustFile, {});
	const own = existsSync(join(p.home, "keys", "app_signing.jwk")) && fingerprint === (await ownFingerprint(p));
	if (trusted[fingerprint] && trusted[fingerprint].publicKey !== lock.signer.publicKey) throw new Error(`The package claims trusted signer ${fingerprint} with a different key; refusing it.`);
	const newSigner = !own && !trusted[fingerprint];
	if (newSigner && !options.trust) throw new Error(`Signed by ${fingerprint}, a key you haven't trusted. If you know who that is, add it again with --trust.`);

	// Install: write to a staging folder, check it reads as an app, then swap it in.
	const apps = join(p.home, "apps");
	const target = join(apps, lock.name);
	const staging = join(apps, `.${lock.name}.installing`);
	rmSync(staging, { recursive: true, force: true });
	for (const [rel, data] of Object.entries(contents)) {
		const dest = join(staging, rel);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, data);
	}
	mkdirSync(join(staging, ".lab"), { recursive: true });
	writeFileSync(join(staging, LOCK), `${JSON.stringify(lock, null, 2)}\n`);
	const manifest = readManifest(staging);
	if (manifest.name !== lock.name) throw new Error("The package's app.json names a different app than its lock.");
	rmSync(target, { recursive: true, force: true });
	renameSync(staging, target);
	if (newSigner) writeJson(trustFile, { ...trusted, [fingerprint]: { publicKey: lock.signer.publicKey, added: new Date().toISOString() } });
	return { name: lock.name, version: lock.version, dir: target, fingerprint, newSigner };
}

export function removeApp(p: Paths, name: string): boolean {
	if (!APP_NAME.test(name)) return false;
	const dir = join(p.home, "apps", name);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}
