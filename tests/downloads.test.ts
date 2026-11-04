// Files leaving a lab sandbox: the lab scans each one first and sends the sha-256 of the bytes it passed
// (Repr-Digest, RFC 9530). The client keeps a file only when it matches, waits while the scanner is down, and says in
// plain words when a scanner stopped the file or it's over the person's limit.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateSite, reprSha256 } from "../packages/engine/src/sites/gate.ts";

const body = "plot,value\na,1\n";
const digest = (text: string) => `sha-256=:${createHash("sha256").update(text).digest("base64")}:`;
let mode: "good" | "bad" | "none" | "refused" | "busy" | "queued" | "big" | "cut" | "short" = "good";
let busy = 0;
let reads = 0;

const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true }, sign_in: { kind: "key" } });
		if (pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [], sandboxes: { enabled: true } });
		if (pathname === "/v1/models") return Response.json({ data: [] });
		if (pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (pathname === "/v1/containers/c1/files") return Response.json({ data: [{ id: "f1", path: "/sandbox/out/a.csv", bytes: body.length }] });
		if (pathname === "/v1/containers/c1/files/f1/content") {
			if (mode === "refused") return Response.json({ error: { code: "file_refused", message: "refused" } }, { status: 422 });
			if (mode === "big") return Response.json({ error: { code: "file_too_large", message: "too large" } }, { status: 413 });
			if (mode === "busy" && busy++ === 0) return Response.json({ error: { code: "scanner_unavailable", message: "down" } }, { status: 503, headers: { "retry-after": "0" } });
			if (mode === "queued" && busy++ === 0) return Response.json({ error: { code: "downloads_in_progress", message: "busy" } }, { status: 429, headers: { "retry-after": "0" } });
			reads++;
			// The lab ends a stalled or overlong download early: the first read breaks off partway, or (short) every
			// read does and carries no digest.
			if ((mode === "cut" && reads === 1) || mode === "short") {
				const half = new TextEncoder().encode(body.slice(0, 5));
				const stream = new ReadableStream<Uint8Array>({
					async pull(c) {
						c.enqueue(half);
						await Bun.sleep(20);
						c.error(undefined); // drops the connection, as a lab ending the download does
					},
				});
				return new Response(stream, { headers: { "content-type": "text/csv", ...(mode === "cut" ? { "repr-digest": digest(body) } : {}) } });
			}
			const headers: Record<string, string> = { "content-type": "text/csv" };
			if (mode !== "none") headers["repr-digest"] = `sha-512=:AAAA:, ${digest(mode === "bad" ? "something else" : body)}`;
			return new Response(body, { headers });
		}
		return new Response("", { status: 404 });
	},
});
const dir = mkdtempSync(join(tmpdir(), "el-downloads-"));
afterAll(() => {
	lab.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

const base = `http://127.0.0.1:${lab.port}`;
const site = async () => {
	const s = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, "c1");
	await s.connect();
	return s;
};

describe("files leaving a lab sandbox", () => {
	test("Repr-Digest is read from a dictionary with other algorithms", () => {
		const response = new Response("", { headers: { "repr-digest": `sha-512=:AAAA:, ${digest(body)}` } });
		expect(reprSha256(response)).toBe(createHash("sha256").update(body).digest("hex"));
		expect(reprSha256(new Response(""))).toBeUndefined();
	});

	test("a file whose bytes match the digest is saved; one that doesn't is dropped with its temporary copy", async () => {
		const s = await site();
		mode = "good";
		const saved = await s.get("/sandbox/out/a.csv", join(dir, "good.csv"));
		expect(saved.bytes).toBe(body.length);
		expect(readFileSync(join(dir, "good.csv"), "utf8")).toBe(body);
		mode = "bad";
		await expect(s.get("/sandbox/out/a.csv", join(dir, "bad.csv"))).rejects.toThrow("wasn't saved");
		expect(existsSync(join(dir, "bad.csv"))).toBe(false);
		expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
		// A lab that sends no digest yet still works.
		mode = "none";
		await s.get("/sandbox/out/a.csv", join(dir, "plain.csv"));
		expect(readFileSync(join(dir, "plain.csv"), "utf8")).toBe(body);
	});

	test("a file returned by reference is checked the same way", async () => {
		const s = await site();
		mode = "good";
		expect(new TextDecoder().decode(await s.fetchFile(`${base}/v1/containers/c1/files/f1/content`, AbortSignal.timeout(5_000)))).toBe(body);
		mode = "bad";
		await expect(s.fetchFile(`${base}/v1/containers/c1/files/f1/content`, AbortSignal.timeout(5_000))).rejects.toThrow("doesn't match the checksum");
	});

	test("the scanner being down is waited out; a refused or oversized file is said plainly", async () => {
		const s = await site();
		mode = "busy";
		busy = 0;
		await s.get("/sandbox/out/a.csv", join(dir, "later.csv"));
		expect(busy).toBe(2);
		// Past the person's concurrent scans: the download waits its turn.
		mode = "queued";
		busy = 0;
		await s.get("/sandbox/out/a.csv", join(dir, "queued.csv"));
		expect(busy).toBe(2);
		mode = "refused";
		await expect(s.get("/sandbox/out/a.csv", join(dir, "refused.csv"))).rejects.toThrow("The malware scanner stopped this file from leaving the sandbox.");
		mode = "big";
		await expect(s.get("/sandbox/out/a.csv", join(dir, "big.csv"))).rejects.toThrow("larger than Dev Lab lets you download");
	});

	test("a download the lab ends partway is tried once more from the start, and never kept short", async () => {
		const s = await site();
		mode = "cut";
		reads = 0;
		await s.get("/sandbox/out/a.csv", join(dir, "again.csv"));
		expect(reads).toBe(2);
		expect(readFileSync(join(dir, "again.csv"), "utf8")).toBe(body);
		mode = "short";
		reads = 0;
		await expect(s.get("/sandbox/out/a.csv", join(dir, "short.csv"))).rejects.toThrow("stopped partway");
		expect(reads).toBe(2);
		expect(existsSync(join(dir, "short.csv"))).toBe(false);
		expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
	});
});
