// Apps a lab offers: the client reads the lab's list and signers, installs a package only when it matches the listing
// and verifies against a signer the lab vouches for (trusted for that lab's apps only), records where it came from,
// and stops opening it once the lab withdraws that version or revokes its signer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppHost } from "../packages/engine/src/apps/host.ts";
import { installApp, packApp } from "../packages/engine/src/apps/package.ts";
import { templateFiles } from "../packages/engine/src/apps/templates.ts";
import { paths } from "../packages/engine/src/paths.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";
import type { LabAppEntry, LabSigner } from "../packages/engine/src/sites/contract.ts";
import { Sites } from "../packages/engine/src/sites/sites.ts";
import { writeJson } from "../packages/engine/src/util.ts";

const root = mkdtempSync(join(tmpdir(), "el-labapps-"));
const publisher = paths(join(root, "publisher"));
const person = paths(join(root, "person"));
const listing: { apps: LabAppEntry[]; signers: LabSigner[]; packages: Map<string, Uint8Array> } = { apps: [], signers: [], packages: new Map() };

const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer lab-key") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "enrichedlab", title: "Home Lab", endpoints: { apps: true, signers: true }, sign_in: { kind: "key" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/apps") return Response.json({ data: listing.apps });
		if (url.pathname === "/v1/signers") return Response.json({ data: listing.signers });
		const bytes = listing.packages.get(url.pathname);
		if (bytes) return new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { headers: { etag: `"${createHash("sha256").update(bytes).digest("hex")}"` } });
		return new Response("", { status: 404 });
	},
});

let sites: Sites;
let changed = 0;
const publish = async (version: string) => {
	const dir = join(root, `src-${version}`);
	for (const [rel, body] of Object.entries(templateFiles("blank", "plot-view", "Plot view", ""))) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), rel === "app.json" ? JSON.stringify({ ...JSON.parse(body), version }) : body);
	}
	const packed = await packApp(publisher, dir, join(root, "out"));
	const bytes = new Uint8Array(readFileSync(packed.file));
	const path = `/v1/apps/plot-view/${version}/package`;
	listing.packages.set(path, bytes);
	listing.apps.unshift({ name: "plot-view", title: "Plot view", version, description: "Plots by treatment", signer: { fingerprint: packed.fingerprint, name: "Lab apps" }, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, package: path, withdrawn_at: null });
	return packed;
};

beforeAll(async () => {
	mkdirSync(person.run, { recursive: true });
	mkdirSync(join(root, "out"), { recursive: true });
	// Packing once makes the publisher's key; the lab vouches for its public half (raw key, base64).
	const packed = await publish("1.0.0");
	const jwk = JSON.parse(readFileSync(join(publisher.home, "keys", "app_signing.jwk"), "utf8")) as { x: string };
	listing.signers = [{ fingerprint: packed.fingerprint, public_key: Buffer.from(jwk.x, "base64url").toString("base64"), name: "Lab apps", revoked_at: null }];
	writeFileSync(join(root, "lab.key"), "lab-key", { mode: 0o600 });
	writeJson(person.sites, { sites: [{ name: "home", title: "Home Lab", url: "https://lab.example.org", kind: "gate", lan: { url: `http://127.0.0.1:${lab.port}`, keyFile: join(root, "lab.key") } }] });
	sites = new Sites(person, () => undefined);
	sites.onAppsChanged = () => void changed++;
	await sites.connect("home");
	for (let i = 0; i < 100 && !changed; i++) await Bun.sleep(10);
});
afterAll(async () => {
	await sites?.close();
	lab.stop(true);
	rmSync(root, { recursive: true, force: true });
});

/** Reconnect and wait until the lab's app list has been read again. */
async function refresh() {
	const before = changed;
	await sites.connect("home");
	for (let i = 0; i < 200 && changed === before; i++) await Bun.sleep(10);
}

const host = () =>
	new AppHost({
		paths: person,
		emit: () => undefined,
		session: (id) => (id === "s1" ? { project: root, workspace: new LocalWorkspace(root), place: "local", sealed: false, prompt: () => undefined, context: () => undefined, ask: async () => "" } : undefined),
		sandbox: () => undefined,
		isolated: () => false,
		bundles: () => [],
		origin: () => "http://127.0.0.1:9",
		labAppBlocked: (origin) => sites.appBlocked(origin),
		resolveLab: (name) => sites.resolve(name),
	});

describe("apps from a lab", () => {
	test("the lab's list shows up with who signed it, and the lab's own name maps to the site here", () => {
		const offered = sites.labApps();
		expect(offered.map((a) => [a.site, a.lab, a.name, a.version, a.withdrawn, a.signerRevoked])).toEqual([["home", "Home Lab", "plot-view", "1.0.0", false, false]]);
		expect(sites.resolve("enrichedlab")).toBe("home");
		expect(sites.resolve("home")).toBe("home");
	});

	test("install checks the package against the listing, trusts the lab's signer for that lab only, and records the origin", async () => {
		const installed = await sites.installLabApp("home", "plot-view");
		expect(installed).toEqual({ name: "plot-view", version: "1.0.0" });
		const origin = JSON.parse(readFileSync(join(person.home, "apps", "plot-view", ".lab", "origin.json"), "utf8"));
		expect(origin).toMatchObject({ lab: "home", name: "plot-view", version: "1.0.0", signer: listing.signers[0]!.fingerprint });
		const trusted = JSON.parse(readFileSync(join(person.home, "trusted_signers.json"), "utf8"));
		expect(trusted[listing.signers[0]!.fingerprint].via).toBe("lab:home");
		const summary = host().list().find((a) => a.name === "plot-view")!;
		expect(summary.source).toBe("lab:home");
		// The same signer's package added by hand isn't covered by the lab's word.
		const file = join(root, "sideload.labapp");
		writeFileSync(file, listing.packages.get("/v1/apps/plot-view/1.0.0/package")!);
		await expect(installApp(person, file)).rejects.toThrow("a key you haven't trusted");
	});

	test("a package that doesn't match its listing isn't installed", async () => {
		const entry = listing.apps[0]!;
		const good = entry.sha256;
		entry.sha256 = "0".repeat(64);
		await refresh();
		await expect(sites.installLabApp("home", "plot-view")).rejects.toThrow("doesn't match");
		entry.sha256 = good;
	});

	test("a withdrawn version, or a revoked signer, stops the app from opening and keeps it installed", async () => {
		listing.apps[0]!.withdrawn_at = "2026-11-04T12:00:00Z";
		await refresh();
		await expect(host().open({ sessionId: "s1", id: "plot-view" })).rejects.toThrow("Home Lab withdrew plot-view 1.0.0");
		expect(existsSync(join(person.home, "apps", "plot-view"))).toBe(true);
		listing.apps[0]!.withdrawn_at = null;
		listing.signers[0]!.revoked_at = "2026-11-04T12:30:00Z";
		await refresh();
		await expect(host().open({ sessionId: "s1", id: "plot-view" })).rejects.toThrow("no longer vouches for the key");
		await expect(sites.installLabApp("home", "plot-view")).rejects.toThrow("doesn't vouch for the key");
		listing.signers[0]!.revoked_at = null;
	});
});
