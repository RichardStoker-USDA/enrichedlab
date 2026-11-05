// A lab sandbox's lifecycle from the client's side: a stopped sandbox starts on use (409 sandbox_starting with
// Retry-After), an archived one is restored and polled until it runs, a deleted one is replaced, and an expired one
// (410) is forgotten so the next command starts fresh.

import { afterAll, describe, expect, test } from "bun:test";
import { GateSite } from "../packages/engine/src/sites/gate.ts";

const box = new Map<string, { status: string; polls: number; files: string }>();
const calls: string[] = [];
let made = 0;
// How the next new sandbox is refused: once while Gate is busy, or because the person holds too many or storage is full.
let refuse: "" | "busy-once" | "full" | "storage" | "one-at-once" = "";
let deletes = 0;
// Whether the lab says it can stop sandboxes (endpoints.stop).
let stops = true;

const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		const { pathname } = url;
		calls.push(`${request.method} ${pathname}`);
		if (pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, ...(stops ? { stop: true } : {}) }, sign_in: { kind: "key" } });
		if (pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [], sandboxes: { enabled: true } });
		if (pathname === "/v1/models") return Response.json({ data: [] });
		if (pathname === "/v1/containers" && request.method === "POST") {
			if (refuse === "busy-once") {
				refuse = "";
				return Response.json({ error: { code: "sandbox_busy", message: "Gate is busy starting other sandboxes. Try again shortly." } }, { status: 503, headers: { "retry-after": "0" } });
			}
			if (refuse === "full") return Response.json({ error: { code: "too_many_containers", limit: "held", message: "You hold 20 containers, the most one person may keep. Delete one you no longer need first." } }, { status: 429 });
			// One sandbox at a time: one still being deleted counts until it's gone.
			if (refuse === "one-at-once" && [...box.values()].some((c) => c.status === "deleting")) return Response.json({ error: { code: "too_many_containers", limit: "at_once", message: "You may run 1 sandbox at once. Stop or delete one first." } }, { status: 429 });
			if (refuse === "storage") return Response.json({ error: { code: "storage_full", message: "Your files and resting sandboxes fill your storage. Delete some first." } }, { status: 413 });
			const id = `new${++made}`;
			box.set(id, { status: "running", polls: 0, files: "" });
			return Response.json({ id, status: "running" });
		}
		if (pathname === "/v1/containers" && request.method === "GET") {
			const data = [...box].filter(([, c]) => c.status !== "deleted").map(([id, c]) => ({ id, object: "container", name: "EnrichedLab", status: c.status, created_at: 1_793_000_000, last_active_at: 1_793_000_600, memory_limit: "4g" }));
			return Response.json({ object: "list", data, has_more: false });
		}
		const match = /^\/v1\/containers\/([^/]+)(\/.*)?$/.exec(pathname);
		if (!match) return new Response("", { status: 404 });
		const [, id, rest] = match;
		const c = box.get(id!);
		if (!c || c.status === "deleted") return Response.json({ error: { code: "not_found", message: "no such container" } }, { status: 404 });
		if (!rest && request.method === "DELETE") {
			// One delete at a time per person; a sandbox whose files take a while reads deleted while Gate finishes.
			if (deletes++ === 0) return Response.json({ error: { code: "too_many_deletes", message: "Up to 2 container deletes run at once." } }, { status: 429, headers: { "retry-after": "0" } });
			c.status = "deleted";
			return c.files === "slow-delete" ? Response.json({ id, object: "container.deleted", deleted: false, status: "deleting" }, { status: 202 }) : Response.json({ id, object: "container.deleted", deleted: true });
		}
		if (!rest) {
			// A delete in progress, starting and restoring finish after a couple of looks.
			if (c.status === "deleting" && c.files === "goes" && ++c.polls >= 2) {
				c.status = "deleted";
				return Response.json({ error: { code: "not_found", message: "no such container" } }, { status: 404 });
			}
			if ((c.status === "starting" || c.status === "restoring") && ++c.polls >= 2) c.status = c.status === "restoring" && c.files === "fail" ? "archived" : "running";
			return Response.json({ id, status: c.status });
		}
		if (rest === "/restore") {
			if (c.files === "too-big") return Response.json({ error: { code: "restore_files_over_limit", message: "Its saved files are 12.3 GiB; a sandbox may hold 10 GiB now." } }, { status: 403 });
			if (c.files === "too-wide") return Response.json({ error: { code: "restore_memory_over_limit", message: "This sandbox has 16g; you may start up to 4g now." } }, { status: 403 });
			if (c.status !== "archived" && c.status !== "restoring") return Response.json({ error: { code: "bad_request" } }, { status: 400 });
			c.status = "restoring";
			c.polls = 0;
			return Response.json({ id, status: "restoring" }, { status: 202 });
		}
		if (rest === "/stop") {
			// A lab from before the route answers a bare 404.
			if (c.files === "no-stop") return new Response("", { status: 404 });
			if (c.files === "jobs") return Response.json({ error: { code: "sandbox_has_jobs", message: "Background jobs are still running here. Cancel them first, or let them finish." } }, { status: 409 });
			if (c.status === "archived" || c.status === "stopped") return Response.json({ id, status: c.status });
			if (c.status !== "running") return Response.json({ error: { code: "sandbox_not_running", message: `This sandbox is ${c.status}, so there is nothing to stop.` } }, { status: 409 });
			c.status = "stopped";
			return c.files === "slow-stop" ? Response.json({ id, status: "stopping" }, { status: 202 }) : Response.json({ id, status: "stopped" });
		}
		if (c.files === "expired") return Response.json({ error: { code: "container_expired", message: "expired" } }, { status: 410 });
		if (c.status === "stopped" || c.status === "starting") {
			c.status = "starting";
			return Response.json({ error: { code: "sandbox_starting", message: "starting" } }, { status: 409, headers: { "retry-after": "0" } });
		}
		if (c.status === "archived") return Response.json({ error: { code: "sandbox_archived", message: "archived" } }, { status: 409 });
		if (rest === "/exec") return Response.json({ exit_code: 0, stdout: `ran in ${id}\n`, stderr: "" });
		if (rest.startsWith("/files")) return Response.json({ data: [] });
		return new Response("", { status: 404 });
	},
});
afterAll(() => lab.stop(true));

const base = `http://127.0.0.1:${lab.port}`;
async function site(container: string, state: { status: string; files?: string }) {
	box.set(container, { status: state.status, polls: 0, files: state.files ?? "" });
	const s = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, container);
	const notices: string[] = [];
	s.onNotice = (text) => notices.push(text);
	await s.connect();
	return { s, notices };
}

describe("sandbox lifecycle", () => {
	test("a stopped sandbox starts on use and the command runs in it", async () => {
		const { s } = await site("c-stopped", { status: "stopped" });
		expect((await s.run("echo hi", 30)).stdout).toBe("ran in c-stopped\n");
		expect(box.get("c-stopped")!.status).toBe("running");
	});

	test("a command that meets a starting sandbox waits as the lab says and is sent again", async () => {
		const { s } = await site("c-race", { status: "running" });
		box.get("c-race")!.status = "stopped";
		// The status read said running a moment ago; the exec itself gets 409 sandbox_starting, waits, and retries.
		const original = box.get("c-race")!;
		const done = s.run("echo hi", 30);
		await Bun.sleep(10);
		original.status = "running";
		expect((await done).stdout).toBe("ran in c-race\n");
	});

	test("an archived sandbox is restored, polled until it runs, and the person is told", async () => {
		const { s, notices } = await site("c-archived", { status: "archived" });
		expect((await s.run("echo hi", 30)).stdout).toBe("ran in c-archived\n");
		expect(calls).toContain("POST /v1/containers/c-archived/restore");
		expect(notices.join(" ")).toContain("Restoring your Dev Lab sandbox from its archive");
	}, 30_000);

	test("a restore the lab refuses says why and what to ask for", async () => {
		const { s } = await site("c-toobig", { status: "archived", files: "too-big" });
		await expect(s.run("echo hi", 30)).rejects.toThrow("Dev Lab won't restore your archived sandbox: Its saved files are 12.3 GiB; a sandbox may hold 10 GiB now. Ask the lab to raise your disk limit, or to delete the archive.");
		const wide = await site("c-toowide", { status: "archived", files: "too-wide" });
		await expect(wide.s.run("echo hi", 30)).rejects.toThrow("Dev Lab won't restore your archived sandbox: This sandbox has 16g; you may start up to 4g now. Ask the lab to raise your memory limit.");
	});

	test("a failed restore says so instead of running somewhere else", async () => {
		const { s } = await site("c-badrestore", { status: "archived", files: "fail" });
		await expect(s.run("echo hi", 30)).rejects.toThrow("still archived");
	}, 30_000);

	test("a deleted sandbox, or one still being deleted, is replaced with a new one, and the person is told", async () => {
		const { s, notices } = await site("c-deleted", { status: "deleted" });
		const result = await s.run("echo hi", 30);
		expect(result.stdout).toMatch(/^ran in new\d+\n$/);
		expect(notices.join(" ")).toContain("was deleted, with its files");
		const going = await site("c-deleting", { status: "deleting" });
		const started = Date.now();
		expect((await going.s.run("echo hi", 30)).stdout).toMatch(/^ran in new\d+\n$/);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("with one sandbox allowed at a time, a new one waits for the one still being deleted, then starts", async () => {
		// Earlier tests leave sandboxes mid-delete; only this test's count here.
		for (const [id, c] of box) if (c.status === "deleting") box.delete(id);
		refuse = "one-at-once";
		const { s } = await site("c-going", { status: "deleting", files: "goes" });
		expect((await s.run("echo hi", 30)).stdout).toMatch(/^ran in new\d+\n$/);
		expect(box.get("c-going")!.status).toBe("deleted");
		// One that stays deleting: the lab's refusal stands, with where to act on it.
		GateSite.leavingWaitMs = 50;
		const stuck = await site("c-stuck", { status: "deleting" });
		await expect(stuck.s.run("echo hi", 30)).rejects.toThrow("You may run 1 sandbox at once. Stop or delete one first. el sandboxes devlab lists your sandboxes there; el sandbox stop devlab <id> stops one and keeps its files, el sandbox delete devlab <id> removes one.");
		box.delete("c-stuck");
		GateSite.leavingWaitMs = 60_000;
		refuse = "";
	}, 15_000);

	test("a lab too busy to take a new sandbox is waited out; one that's full says how to make room", async () => {
		const { s } = await site("c-gone", { status: "deleted" });
		refuse = "busy-once";
		const posts = () => calls.filter((c) => c === "POST /v1/containers").length;
		const before = posts();
		expect((await s.run("echo hi", 30)).stdout).toMatch(/^ran in new\d+\n$/);
		expect(posts() - before).toBe(2);
		const full = await site("c-gone-too", { status: "deleted" });
		refuse = "full";
		await expect(full.s.run("echo hi", 30)).rejects.toThrow("You hold 20 containers, the most one person may keep. Delete one you no longer need first. el sandboxes devlab lists your sandboxes there; el sandbox delete devlab <id> removes one.");
		refuse = "storage";
		await expect(full.s.run("echo hi", 30)).rejects.toThrow("fill your storage. Delete some first. el sandboxes devlab lists");
		refuse = "";
	});

	test("the person's sandboxes are listed, and deleting one waits its turn and says when the lab is still clearing it", async () => {
		const { s } = await site("c-mine", { status: "running" });
		box.set("c-old", { status: "archived", polls: 0, files: "slow-delete" });
		await s.run("echo hi", 30);
		const listed = await s.sandboxes();
		expect(listed.find((b) => b.id === "c-mine")).toMatchObject({ status: "running", current: true, stoppable: true, memory: "4g", created: "2026-10-26T07:33:20.000Z" });
		expect(listed.find((b) => b.id === "c-old")).toMatchObject({ status: "archived", current: false, stoppable: false });
		deletes = 0;
		expect(await s.deleteSandbox("c-old")).toBe("deleting");
		expect(deletes).toBe(2);
		expect(await s.deleteSandbox("c-mine")).toBe("deleted");
		expect((await s.sandboxes()).map((b) => b.id)).not.toContain("c-old");
		// The engine's own one is gone: the next command starts a new sandbox.
		expect((await s.run("echo hi", 30)).stdout).toMatch(/^ran in new\d+\n$/);
	});

	test("a running sandbox is stopped with its files kept, and its next use starts it again", async () => {
		const { s } = await site("c-stop", { status: "running" });
		expect(await s.stopSandbox("c-stop")).toBe("stopped");
		expect(box.get("c-stop")!.status).toBe("stopped");
		expect((await s.run("echo hi", 30)).stdout).toBe("ran in c-stop\n");
		box.set("c-slow-stop", { status: "running", polls: 0, files: "slow-stop" });
		expect(await s.stopSandbox("c-slow-stop")).toBe("stopping");
		box.set("c-jobs", { status: "running", polls: 0, files: "jobs" });
		await expect(s.stopSandbox("c-jobs")).rejects.toThrow("Background jobs are still running here");
		box.set("c-restoring", { status: "restoring", polls: 0, files: "" });
		await expect(s.stopSandbox("c-restoring")).rejects.toThrow("This sandbox is restoring, so there is nothing to stop.");
		// The route missing where the descriptor says it's there, and an id the lab doesn't know: both 404, told apart.
		box.set("c-no-stop", { status: "running", polls: 0, files: "no-stop" });
		await expect(s.stopSandbox("c-no-stop")).rejects.toThrow("Dev Lab can't stop sandboxes yet. el sandbox delete devlab c-no-stop removes it");
		await expect(s.stopSandbox("c-nobody")).rejects.toThrow("no such container");
		for (const id of ["c-slow-stop", "c-jobs", "c-restoring", "c-no-stop"]) box.delete(id);
		// A lab whose descriptor doesn't offer stop isn't asked, and its sandboxes aren't offered for stopping.
		stops = false;
		const older = await site("c-older", { status: "running" });
		const before = calls.length;
		await expect(older.s.stopSandbox("c-older")).rejects.toThrow("Dev Lab can't stop sandboxes yet.");
		expect(calls.slice(before).some((c) => c.endsWith("/stop"))).toBe(false);
		expect((await older.s.sandboxes()).find((b) => b.id === "c-older")).toMatchObject({ stoppable: false });
		stops = true;
		box.delete("c-older");
	});

	test("an expired sandbox (410) is forgotten so the next command starts fresh", async () => {
		const { s } = await site("c-expired", { status: "running", files: "expired" });
		await expect(s.run("echo hi", 30)).rejects.toThrow("expired, with its files");
		box.set("c-expired", { status: "deleted", polls: 0, files: "" });
		expect((await s.run("echo hi", 30)).stdout).toMatch(/^ran in new\d+\n$/);
	});
});
