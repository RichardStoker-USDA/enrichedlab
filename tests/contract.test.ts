// The lab contract from the client's side: schemas, the descriptor, `el lab check` against a local lab that follows
// the contract, the event stream's cursor and reset, files by reference, and unreviewed lab tools.

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { toTools } from "../packages/engine/src/mcp.ts";
import { decide } from "../packages/engine/src/permissions.ts";
import { contractProblem, type LabDescriptor, SCHEMAS, validate } from "../packages/engine/src/sites/contract.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";

const descriptor: LabDescriptor = {
	contract: "2026-11",
	name: "devlab",
	title: "Dev Lab",
	endpoints: { models: true, bundles: true, events: true, guard: true, usage: true, containers: true, attach: true },
	sign_in: { kind: "cloudflare-access-oauth" },
	policy: { keep_data_inside: false },
	support: { url: "https://help.example.org" },
	sandbox_profiles: [{ name: "small", cpu: 2, memory: "4Gi" }],
	conformance: { foreign_scope: "otherlab" },
};
const me = {
	subject: "u_9f2c41aa",
	handle: "pat",
	memberships: [
		{ lab: "devlab", research_group: "soils", roles: ["researcher"] },
		{ lab: "devlab", research_group: null, roles: ["member"] },
	],
	policy: { keep_data_inside: false },
};
const seen: { cursor?: string | null; deleted?: string } = {};

const lab = Bun.serve<{ stdin: string; started: boolean }, never>({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request, srv): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		const etagged = (body: unknown) => {
			const etag = `"${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)}"`;
			if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
			return Response.json(body, { headers: { etag } });
		};
		switch (url.pathname) {
			case "/.well-known/enrichedlab-lab":
				return etagged(descriptor);
			case "/v1/me":
				return etagged(me);
			case "/v1/models":
				return etagged({ data: [{ id: "lab-model", gate: { context: 65536, capabilities: ["reasoning"], efforts: ["low", "high"] } }] });
			case "/v1/bundles":
				return etagged({ data: [{ name: "lab-basics", version: "1", files: [{ path: "AGENTS.md", content: "Be careful with data." }] }] });
			case "/v1/guard":
				return Response.json({ decision: "allow", categories: [], reasons: [], policy_version: "g1", receipt_id: "r1" });
			case "/v1/usage":
				if (url.searchParams.get("lab") === "otherlab") return Response.json({ error: { message: "not yours" } }, { status: 403 });
				return Response.json({ window: "7d", rows: [{ lab: "devlab", tokens: { input: 10, output: 5 }, gpu_seconds: 0, sandbox_seconds: 30 }] });
			case "/v1/containers":
				return Response.json({ id: "c1", status: "running", image_digest: `sha256:${"a".repeat(64)}` });
			case "/v1/containers/c1/exec":
				return Response.json({ exit_code: 0, stdout: "ok\n", stderr: "" });
			case "/v1/containers/c1/attach":
				return srv.upgrade(request, { data: { stdin: "", started: false } }) ? undefined : new Response("", { status: 400 });
			case "/v1/files/f1/content":
				return new Response("plot,yield\nP1,5.1\n");
			case "/v1/events": {
				seen.cursor = request.headers.get("last-event-id");
				const body =
					seen.cursor === "0"
						? `event: reset\nid: 7\ndata: {"cursor":"7"}\n\n`
						: `: keepalive\n\nid: 8\nevent: job.finished\ndata: {"type":"job.finished","at":"2026-11-04T10:00:00Z","id":"8","status":"done","summary":"model fit"}\n\nid: 9\nevent: quota.warning\ndata: {"type":"quota.warning","at":"2026-11-04T10:01:00Z","id":"9","kind":"GPU hours","used":8,"limit":10}\n\n`;
				return new Response(body, { headers: { "content-type": "text/event-stream" } });
			}
		}
		if (request.method === "DELETE" && url.pathname === "/v1/containers/c1") {
			seen.deleted = "c1";
			return Response.json({ ok: true });
		}
		return new Response("", { status: 404 });
	},
	// Stands in for the check's `read line; echo got:$line; read more; echo also:$more; echo note >&2; exit 3`.
	websocket: {
		message(ws, raw) {
			const frame = JSON.parse(String(raw)) as { argv?: string[]; stdin?: string; eof?: boolean };
			if (!ws.data.started) {
				ws.data.started = frame.argv?.[0] === "sh";
				return;
			}
			const b64 = (s: string) => Buffer.from(s).toString("base64");
			if (frame.stdin) {
				ws.data.stdin += Buffer.from(frame.stdin, "base64").toString();
				const lines = ws.data.stdin.split("\n");
				// Answer each line as it arrives, as a live process does.
				if (lines.length === 2) ws.send(JSON.stringify({ stdout: b64(`got:${lines[0]}\n`) }));
				if (lines.length === 3) ws.send(JSON.stringify({ stdout: b64(`also:${lines[1]}\n`) }));
			}
			if (frame.eof) {
				ws.send(JSON.stringify({ stderr: b64("note\n") }));
				ws.send(JSON.stringify({ exit_code: 3 }));
				ws.close();
			}
		},
	},
});
afterAll(() => lab.stop(true));

const base = `http://127.0.0.1:${lab.port}`;
const site = () => new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) });

describe("lab contract", () => {
	test("schemas accept the agreed shapes and say what's wrong with others", () => {
		expect(validate(SCHEMAS.lab, descriptor)).toEqual([]);
		expect(validate(SCHEMAS.me, me)).toEqual([]);
		const bad = validate(SCHEMAS.me, { subject: "pat@example.org", memberships: [{ lab: "x" }] });
		expect(bad.join(" | ")).toContain("$.subject must not match");
		expect(bad.join(" | ")).toContain("$.memberships[0].roles is missing");
		expect(validate(SCHEMAS.me, { ...me, memberships: [{ lab: "devlab", research_group: 7, roles: [] }] })).toEqual(["$.memberships[0].research_group is integer, expected string or null"]);
		expect(contractProblem({ ...descriptor, contract: "2026-11.2" })).toBeUndefined();
		expect(contractProblem({ ...descriptor, contract: "2027-03" })).toContain("speaks lab contract 2027-03");
	});

	test("connect reads the descriptor and answers repeat reads from ETags", async () => {
		const s = site();
		await s.connect();
		expect([s.title, s.descriptor?.support?.url, s.models.map((m) => m.id)]).toEqual(["Dev Lab", "https://help.example.org", ["lab-model"]]);
		expect(await s.bundles()).toHaveLength(1);
		await s.connect();
		expect(s.who).toBe("pat");
	});

	test("el lab check passes a lab that follows the contract, and cleans up its sandbox", async () => {
		const rows = await site().check();
		const failed = rows.filter((r) => r.status === "fail");
		expect(failed).toEqual([]);
		expect(rows.find((r) => r.row === "old cursor")?.detail).toContain("reset");
		expect(rows.find((r) => r.row === "another lab's scope")?.status).toBe("pass");
		expect(rows.find((r) => r.row === "attach")?.status).toBe("pass");
		expect(rows.find((r) => r.row === "attach streams stdin")?.status).toBe("pass");
		expect(seen.deleted).toBe("c1");
	});

	test("the event stream keeps its cursor and resumes from it", async () => {
		const events: string[] = [];
		const cursors: string[] = [];
		const stop = site().follow("8", { event: (e) => events.push(e.type), cursor: (id) => cursors.push(id), reset: () => events.push("reset") });
		for (let i = 0; i < 50 && events.length < 2; i++) await Bun.sleep(20);
		stop();
		expect(seen.cursor).toBe("8");
		expect(events.slice(0, 2)).toEqual(["job.finished", "quota.warning"]);
		expect(cursors.slice(0, 2)).toEqual(["8", "9"]);
	});

	test("files by reference come only from the lab's own address", async () => {
		const s = site();
		expect(new TextDecoder().decode(await s.fetchFile(`${base}/v1/files/f1/content`, AbortSignal.timeout(5_000)))).toContain("P1,5.1");
		await expect(s.fetchFile("https://elsewhere.example/v1/files/f1/content", AbortSignal.timeout(5_000))).rejects.toThrow("isn't an address of");
	});

	test("an unreviewed lab tool asks every time, and its results arrive as references with a receipt", async () => {
		const sha = "b".repeat(64);
		const client = {
			callTool: async () => ({
				content: [{ type: "resource_link", uri: `${base}/v1/files/f1/content`, name: "plots.csv", mimeType: "text/csv", size: 18, _meta: { "org.enrichedlab/sha256": sha } }],
				_meta: { "org.enrichedlab/receipt": { id: "rc1", code_version: "v3", parameters: { n: 24 } } },
			}),
		};
		const [tool] = toTools("devlab", client as never, [{ name: "query_plots", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { "org.enrichedlab/tier": "unvalidated" } }] as never, "site");
		expect(tool!.unreviewed).toBe(true);
		const verdict = decide(tool!, {}, { kind: "local", inside: () => true } as never, { permissions: { mode: "full", allowCommands: [] } } as never, new Set([`tool:${tool!.name}`]));
		expect(verdict).toMatchObject({ action: "ask", key: `unreviewed!${tool!.name}` });
		const result = await tool!.run({}, { signal: AbortSignal.timeout(5_000) } as never);
		expect(result.view?.files).toEqual([{ uri: `${base}/v1/files/f1/content`, name: "plots.csv", mime: "text/csv", bytes: 18, sha256: sha }]);
		expect(result.content).toContain(`sha256 ${sha}`);
		expect(result.view?.detail).toContain("code version: v3");
	});
});
