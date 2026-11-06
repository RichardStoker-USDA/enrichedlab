// A sandbox port opened on this computer: the loopback proxy forwards HTTP and WebSocket traffic to the lab with the
// person's sign-in, keeps redirects on its own address, and refuses anything that isn't the page it handed out.

import { afterAll, describe, expect, test } from "bun:test";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import { isOpenPort, withoutSandbox } from "../packages/engine/src/sites/port_proxy.ts";

const PORT_PATH = "/v1/containers/c1/ports/8080";
let deleted = false;
const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request, srv): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, ports: true }, sign_in: { kind: "key" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers/c1" && request.method === "DELETE") return (deleted = true), new Response(null, { status: 202 });
		if (url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (url.pathname === `${PORT_PATH}/ws`) return srv.upgrade(request) ? undefined : new Response("", { status: 400 });
		if (url.pathname === `${PORT_PATH}/go2`) return new Response(null, { status: 302, headers: { location: `${PORT_PATH}/landed2` } });
		if (url.pathname === `${PORT_PATH}/go`) return new Response(null, { status: 302, headers: { location: `${url.origin}${PORT_PATH}/landed` } });
		if (url.pathname.startsWith(PORT_PATH) || url.pathname.startsWith("/v1/containers/c1/ports/8081")) {
			// Like Gate: app pages come sandboxed, so they never act with the lab's origin.
			return Response.json(
				{ path: url.pathname.slice(PORT_PATH.length), query: url.search, method: request.method, body: request.body ? await request.text() : "", cookie: request.headers.get("cookie"), origin: request.headers.get("origin") },
				{ headers: { "set-cookie": "app=1; Path=/", "content-security-policy": "sandbox allow-scripts allow-forms; frame-ancestors 'self'" } },
			);
		}
		return new Response("", { status: 404 });
	},
	websocket: {
		message(ws, message) {
			ws.send(`echo ${message}`);
		},
	},
});
afterAll(() => lab.stop(true));

const base = `http://127.0.0.1:${lab.port}`;
const site = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, "c1");

describe("sandbox ports", () => {
	test("the first visit trades its token for a cookie; then requests reach the app with the lab sign-in", async () => {
		await site.connect();
		const opened = await site.openPort(8080, "/app?x=1");
		expect(opened.url).toStartWith(`${opened.origin}/app?x=1&el_port=`);
		const first = await fetch(opened.url, { redirect: "manual" });
		expect(first.status).toBe(303);
		expect(first.headers.get("location")).toBe("/app?x=1");
		const cookie = first.headers.get("set-cookie")!.split(";")[0]!;
		const answer = await fetch(`${opened.origin}/app?x=1`, { method: "POST", body: "a=1", headers: { cookie: `${cookie}; app=1`, origin: opened.origin } });
		// The browser's Origin stays here: the lab refuses writes from a foreign origin.
		expect(await answer.json()).toEqual({ path: "/app", query: "?x=1", method: "POST", body: "a=1", cookie: "app=1", origin: null });
		// The same port opens at the same address.
		expect((await site.openPort(8080)).origin).toBe(opened.origin);
		// Redirects inside the app stay here.
		const moved = await fetch(`${opened.origin}/go`, { redirect: "manual", headers: { cookie } });
		expect(moved.headers.get("location")).toBe("/landed");
		const movedPath = await fetch(`${opened.origin}/go2`, { redirect: "manual", headers: { cookie } });
		expect(movedPath.headers.get("location")).toBe("/landed2");
	});

	test("the page gets the port's own origin: the lab's sandbox directive goes, its other rules stay", async () => {
		const opened = await site.openPort(8080);
		const cookie = (await fetch(opened.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		const page = await fetch(`${opened.origin}/`, { headers: { cookie } });
		expect(page.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
		expect(withoutSandbox("sandbox")).toBe("");
		expect(withoutSandbox("default-src 'self'; sandbox allow-scripts, sandbox")).toBe("default-src 'self'");
		expect(isOpenPort(`${opened.origin}/api`)).toBe(true);
		expect(isOpenPort(opened.origin.replace("127.0.0.1", "localhost"))).toBe(true);
		expect(isOpenPort("http://127.0.0.1:1/")).toBe(false);
	});

	test("a served app starts at once, stops when unused, and starts again on the next visit", async () => {
		const opened = await site.openPort(8081);
		const events: string[] = [];
		await opened.serve(
			{
				start: async () => {
					events.push("start");
					return { ended: new Promise(() => undefined), stop: async () => void events.push("stop") };
				},
			},
			60,
		);
		expect(events).toEqual(["start"]);
		await Bun.sleep(250);
		expect(events).toEqual(["start", "stop"]);
		const cookie = (await fetch(opened.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		expect((await fetch(`${opened.origin}/`, { headers: { cookie } })).status).toBe(200);
		expect(events).toEqual(["start", "stop", "start"]);
		// A server that won't start says why, in place of the page.
		await opened.serve({ start: async () => Promise.reject(new Error("port 8081 is in use")) }, 60_000).catch(() => undefined);
		const failed = await fetch(`${opened.origin}/`, { headers: { cookie } });
		expect(failed.status).toBe(502);
		expect(await failed.text()).toContain("port 8081 is in use");
		opened.close();
		expect(isOpenPort(opened.origin)).toBe(false);
	});

	test("requests without the cookie, from another origin, or for another host are refused", async () => {
		const opened = await site.openPort(8080);
		const cookie = (await fetch(opened.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		expect((await fetch(`${opened.origin}/`)).status).toBe(403);
		expect((await fetch(`${opened.origin}/`, { headers: { cookie, origin: "https://elsewhere.example" } })).status).toBe(403);
		expect((await fetch(`${opened.origin}/`, { headers: { cookie, host: "evil.example" } })).status).toBe(403);
		expect((await fetch(`${opened.origin}/`, { headers: { cookie: `${cookie.split("=")[0]}=wrong` } })).status).toBe(403);
	});

	test("WebSockets go through with the lab sign-in", async () => {
		const opened = await site.openPort(8080);
		const cookie = (await fetch(opened.url, { redirect: "manual" })).headers.get("set-cookie")!.split(";")[0]!;
		const ws = new WebSocket(`${opened.origin.replace("http", "ws")}/ws`, { headers: { cookie, origin: opened.origin } } as unknown as string[]);
		const reply = await new Promise<string>((resolve, reject) => {
			ws.onopen = () => ws.send("hello");
			ws.onmessage = (event) => resolve(String(event.data));
			ws.onerror = () => reject(new Error("socket failed"));
			setTimeout(() => reject(new Error("timed out")), 5_000);
		});
		ws.close();
		expect(reply).toBe("echo hello");
		// Closing keeps the sandbox, with the person's work, for the next start.
		expect(await site.close()).toBe("c1");
		expect(deleted).toBe(false);
	});
});
