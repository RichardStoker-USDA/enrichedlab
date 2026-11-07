// A lab's desktop sandbox (docs/research.md): the agent's tool and the person's pane send one checked action at a time
// to POST /v1/containers/{id}/desktop, marked with who asked, and the picture that comes back reaches the windows.

import { afterAll, describe, expect, test } from "bun:test";
import { checkAction, describeState, desktopTools } from "../packages/engine/src/sites/desktop.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import type { DesktopFrame } from "../packages/protocol/src/index.ts";

process.env.EL_KEYSTORE = "file";
const PNG = Buffer.from("not really a png").toString("base64");
const lab = {
	containers: [] as { id: string; image: string; status: string }[],
	actions: [] as Record<string, unknown>[],
	made: 0,
	/** Containers answering as Gate does for an archived one, until restored. */
	archived: new Set<string>(),
	restored: [] as string[],
	/** Containers that ended (410 container_expired). */
	ended: new Set<string>(),
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
		const restore = /^\/v1\/containers\/([^/]+)\/restore$/.exec(url.pathname);
		if (restore && request.method === "POST") {
			lab.archived.delete(restore[1]!);
			lab.restored.push(restore[1]!);
			return Response.json({ id: restore[1], status: "restoring" }, { status: 202 });
		}
		const one = /^\/v1\/containers\/([^/]+)$/.exec(url.pathname);
		if (one && request.method === "GET") return Response.json({ id: one[1], status: lab.archived.has(one[1]!) ? "archived" : "running" });
		const desk = /^\/v1\/containers\/([^/]+)\/desktop(\/open)?$/.exec(url.pathname);
		if (desk && request.method === "POST") {
			if (lab.ended.has(desk[1]!)) return Response.json({ error: { code: "container_expired", message: "ended" } }, { status: 410 });
			if (!lab.containers.some((c) => c.id === desk[1])) return Response.json({ error: { code: "container_not_found", message: "no such sandbox" } }, { status: 404 });
			if (lab.archived.has(desk[1]!)) return Response.json({ error: { code: "sandbox_archived", message: "archived" } }, { status: 409 });
			const body = (await request.json()) as Record<string, unknown>;
			lab.actions.push({ ...body, container: desk[1], open: Boolean(desk[2]) });
			if (desk[2]) return Response.json({ opened: body.target });
			// As Gate does: a picture only for screenshot and zoom.
			return Response.json(body.action === "screenshot" || body.action === "zoom" ? { ok: true, action: body.action, screenshot: { png: PNG, width: 1280, height: 800 } } : { ok: true, action: body.action });
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
		// The lab answers the click without a picture: the tool takes one just after, so the model sees the result.
		expect(lab.actions.slice(-2).map((a) => [a.action, a.by, a.container])).toEqual([["left_click", "agent", "c1"], ["screenshot", "agent", "c1"]]);
		expect(lab.actions.at(-2)).toMatchObject({ coordinate: [640, 200] });
		expect(frames.at(-1)).toMatchObject({ site: "field", png: PNG, width: 1280, height: 800, by: "agent" });
	});

	test("the person's input goes the same way, marked as theirs; an archived desktop is restored, an ended one made again", async () => {
		const s = site();
		await s.connect();
		await s.desktopAct({ action: "type", text: "summary(plots)" }, "person");
		expect(lab.actions.at(-1)).toMatchObject({ action: "type", text: "summary(plots)", by: "person" });
		// Archived: restored with its files, never replaced.
		lab.archived.add("c1");
		await s.desktopAct({ action: "screenshot" }, "person");
		expect(lab.restored).toEqual(["c1"]);
		expect(lab.containers.map((c) => c.id)).toEqual(["c1"]);
		expect(lab.actions.at(-1)).toMatchObject({ action: "screenshot", container: "c1" });
		// Ended: a new one, once.
		lab.ended.add("c1");
		await s.desktopAct({ action: "screenshot" }, "person");
		expect(lab.containers.map((c) => c.id)).toEqual(["c1", "c2"]);
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

describe("reading a desktop's windows and controls", () => {
	const info = { image: "desktop", screen: { width: 1280, height: 800 }, actions: ["state", "launch", "focus_window", "screenshot", "left_click"], apps: [{ id: "browser", title: "Chromium" }, { id: "text", title: "Text editor" }] };

	test("state, launch and focus_window are checked like any action", () => {
		expect(checkAction({ action: "state" }, info)).toEqual({ action: "state" });
		expect(checkAction({ action: "launch", app: "text" }, info)).toEqual({ action: "launch", app: "text" });
		expect(() => checkAction({ action: "launch", app: "xterm" }, info)).toThrow("This desktop has no app xterm. It has: browser, text.");
		expect(() => checkAction({ action: "launch" }, info)).toThrow("launch needs app: one of browser, text.");
		expect(checkAction({ action: "focus_window", window: "0x1a00003" }, info)).toEqual({ action: "focus_window", window: "0x1a00003" });
		expect(() => checkAction({ action: "focus_window", window: "Text" }, info)).toThrow("focus_window needs window");
		// A lab that lists only the first fourteen actions isn't sent the new ones.
		expect(() => checkAction({ action: "state" }, { image: "desktop", actions: ["screenshot"] })).toThrow("This desktop doesn't take state.");
	});

	test("state reads as windows and the focused window's controls, each with the point to click", () => {
		const text = describeState({
			ok: true,
			action: "state",
			state: {
				screen: { width: 1280, height: 800 },
				cursor: [10, 20],
				windows: [
					{ id: "0x1a00003", app: "text", title: "Untitled", bounds: { x: 100, y: 50, width: 800, height: 600 }, focused: true, minimized: false },
					{ id: "0x1c00001", app: "browser", title: "Example", bounds: [0, 0, 1280, 800], focused: false, minimized: true },
				],
				focused: {
					window: "0x1a00003",
					nodes: 3,
					truncated: false,
					tree: { role: "frame", name: "Untitled", bounds: [100, 50, 800, 600], children: [{ role: "push button", name: "Save", bounds: [110, 60, 40, 20] }, { role: "text", name: "", value: "hello", bounds: [100, 90, 800, 560] }] },
				},
			},
		});
		expect(text).toBe(
			[
				"Screen 1280 by 800. Pointer at (10, 20).",
				"Windows:",
				'- 0x1a00003 text "Untitled" at (100, 50), 800 by 600, focused',
				'- 0x1c00001 browser "Example" at (0, 0), 1280 by 800, minimized',
				"Controls in the focused window 0x1a00003 (click a control at its center):",
				'frame "Untitled" at (500, 350)',
				'  push button "Save" at (130, 70)',
				'  text value "hello" at (500, 370)',
			].join("\n"),
		);
		expect(describeState({ state: { screen: { width: 1, height: 1 }, windows: [] } })).toContain("No windows are open. Use launch to start an app.");
	});

	test("the tool reads state without a picture, and names the window launch opened", async () => {
		const calls: Record<string, unknown>[] = [];
		const api = {
			desktop: () => info,
			desktopAct: async (action: Record<string, unknown>) => {
				calls.push(action);
				if (action.action === "state") return { answer: { state: { screen: { width: 1280, height: 800 }, windows: [] } } };
				if (action.action === "launch") return { answer: { ok: true, window: { id: "0x2200001", title: "Text Editor" } } };
				return { frame: { site: "home", png: PNG, width: 1280, height: 800, by: "agent", at: "" } };
			},
			desktopOpen: async () => ({}),
		};
		const tool = desktopTools("home", "Home Lab", api as never)[0]!;
		expect(tool.description).toStartWith("Use the Linux desktop in your Home Lab sandbox, 1280 by 800 pixels: for programs that only have a window (a PDF form, a viewer, a web page on the lab's network). Start with state:");
		expect((tool.parameters as { properties: Record<string, unknown> }).properties.app).toEqual({ type: "string", enum: ["browser", "text"] });
		const state = await tool.run({ action: "state" }, { signal: new AbortController().signal, vision: true } as never);
		expect(state.content).toContain("No windows are open.");
		expect(state.images).toBeUndefined();
		const launched = await tool.run({ action: "launch", app: "text" }, { signal: new AbortController().signal, vision: true } as never);
		expect(launched.content).toBe('Launched text. Its window is 0x2200001 "Text Editor".');
		expect(launched.images?.length).toBe(1);
		expect(calls.map((c) => c.action)).toEqual(["state", "launch", "screenshot"]);
	});
});
