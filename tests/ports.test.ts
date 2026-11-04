// A sandbox port opened on this computer: the loopback proxy forwards HTTP and WebSocket traffic to the lab with the
// person's sign-in, keeps redirects on its own address, and refuses anything that isn't the page it handed out.

import { afterAll, describe, expect, test } from "bun:test";
import { GateSite } from "../packages/engine/src/sites/gate.ts";

const PORT_PATH = "/v1/containers/c1/ports/8080";
const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request, srv): Promise<Response | undefined> {
		const url = new URL(request.url);
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, ports: true }, sign_in: { kind: "key" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [] });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (url.pathname === `${PORT_PATH}/ws`) return srv.upgrade(request) ? undefined : new Response("", { status: 400 });
		if (url.pathname === `${PORT_PATH}/go2`) return new Response(null, { status: 302, headers: { location: `${PORT_PATH}/landed2` } });
		if (url.pathname === `${PORT_PATH}/go`) return new Response(null, { status: 302, headers: { location: `${url.origin}${PORT_PATH}/landed` } });
		if (url.pathname.startsWith(PORT_PATH)) {
			return Response.json(
				{ path: url.pathname.slice(PORT_PATH.length), query: url.search, method: request.method, body: request.body ? await request.text() : "", cookie: request.headers.get("cookie"), origin: request.headers.get("origin") },
				{ headers: { "set-cookie": "app=1; Path=/" } },
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
		await site.close();
	});
});
