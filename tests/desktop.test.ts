// A lab's desktop sandbox (docs/research.md): the agent's tool and the person's pane send one checked action at a time
// to POST /v1/containers/{id}/desktop, marked with who asked, and the picture that comes back reaches the windows.

import { afterAll, describe, expect, test } from "bun:test";
import { checkAction, desktopTools } from "../packages/engine/src/sites/desktop.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import type { DesktopFrame } from "../packages/protocol/src/index.ts";

process.env.EL_KEYSTORE = "file";
const PNG = Buffer.from("not really a png").toString("base64");
const lab = {
	containers: [] as { id: string; image: string; status: string }[],
	actions: [] as Record<string, unknown>[],
	made: 0,
};
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/.well-known/enrichedlab-lab") {
			return Response.json({
				contract: "2026-11",
				name: "field",
				title: "Field Lab",
				endpoints: { containers: true },
				sign_in: { kind: "oauth" },
				sandbox_desktop: { image: "desktop", screen: { width: 1280, height: 800 }, actions: ["screenshot", "left_click", "type", "key", "scroll"], open: true },
			});
		}
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_123456789", handle: "pat", memberships: [], sandboxes: { enabled: true } });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers" && request.method === "GET") return Response.json({ data: lab.containers });
		if (url.pathname === "/v1/containers" && request.method === "POST") {
			const body = (await request.json()) as { image?: string };
			const made = { id: `c${++lab.made}`, image: body.image ?? "", status: "running" };
			lab.containers.push(made);
			return Response.json(made, { status: 201 });
		}
		const desk = /^\/v1\/containers\/([^/]+)\/desktop(\/open)?$/.exec(url.pathname);
		if (desk && request.method === "POST") {
			if (!lab.containers.some((c) => c.id === desk[1])) return Response.json({ error: { code: "container_not_found", message: "no such sandbox" } }, { status: 404 });
			const body = (await request.json()) as Record<string, unknown>;
			lab.actions.push({ ...body, container: desk[1], open: Boolean(desk[2]) });
			return Response.json({ ok: true, screenshot: { png: PNG, width: 1280, height: 800 } });
		}
		return new Response("", { status: 404 });
	},
});
afterAll(() => server.stop(true));

const site = () => new GateSite({ name: "field", url: "https://field.example.org", kind: "gate" }, { base: `http://127.0.0.1:${server.port}`, via: "key", headers: async () => ({ authorization: "Bearer k" }) });

describe("a lab's desktop sandbox", () => {
	test("the agent's tool acts there, marked as the agent's, and the picture reaches the windows and the model", async () => {
		const s = site();
		const frames: DesktopFrame[] = [];
		s.onDesktopFrame = (frame) => frames.push(frame);
		await s.connect();
		const tool = s.tools.find((t) => t.name === "field_desktop");
		expect(tool?.site).toBe("field");
		expect(tool?.kind).toBe("sandbox");
		expect(s.tools.some((t) => t.name === "field_desktop_open")).toBe(true);
		const result = await tool!.run({ action: "left_click", coordinate: [640.4, 200] }, { signal: new AbortController().signal, vision: true } as never);
		expect(result.content).toBe("Left click at (640, 200).");
		expect(result.images?.[0]).toEqual({ type: "image", mime: "image/png", data: PNG });
		// The desktop is a sandbox of its own, made from the desktop image.
		expect(lab.containers.map((c) => c.image)).toEqual(["desktop"]);
		expect(lab.actions.at(-1)).toMatchObject({ action: "left_click", coordinate: [640, 200], by: "agent", container: "c1" });
		expect(frames.at(-1)).toMatchObject({ site: "field", png: PNG, width: 1280, height: 800, by: "agent" });
	});

	test("the person's input goes the same way, marked as theirs; a desktop the lab removed is made again once", async () => {
		const s = site();
		await s.connect();
		await s.desktopAct({ action: "type", text: "summary(plots)" }, "person");
		expect(lab.actions.at(-1)).toMatchObject({ action: "type", text: "summary(plots)", by: "person" });
		lab.containers = [];
		await s.desktopAct({ action: "screenshot" }, "person");
		expect(lab.containers.map((c) => c.id)).toEqual(["c2"]);
		expect(lab.actions.at(-1)).toMatchObject({ action: "screenshot", container: "c2" });
	});

	test("actions are checked before they go: the lab's list, the screen's edges, typing length", () => {
		const info = { image: "desktop", screen: { width: 1280, height: 800 }, actions: ["screenshot", "left_click", "type"] };
		expect(() => checkAction({ action: "scroll", coordinate: [1, 1] }, info)).toThrow("This desktop doesn't take scroll.");
		expect(() => checkAction({ action: "left_click", coordinate: [1280, 10] }, info)).toThrow("[1280, 10] is off the screen, which is 1280 by 800.");
		expect(() => checkAction({ action: "type", text: "x".repeat(4_001) }, info)).toThrow("Type at most 4000 characters at a time.");
		expect(() => checkAction({ action: "rm -rf" }, info)).toThrow("action must be one of");
		expect(checkAction({ action: "type", text: "ok", stray: 1 }, info)).toEqual({ action: "type", text: "ok" });
	});

	test("a lab without a desktop offers no desktop tools", () => {
		expect(desktopTools("home", "Home Lab", { desktop: () => undefined } as never)).toEqual([]);
	});
});
