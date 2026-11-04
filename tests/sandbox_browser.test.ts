// The browser in a lab's sandbox, end to end against a real headless Chrome: a stand-in lab lists the browser in its
// descriptor and relays its port path to Chrome the way Gate does (Host rewritten to loopback, no Origin), and the
// engine drives it over the DevTools protocol. Skipped where no Chrome is installed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFrame, BrowserPageState } from "../packages/protocol/src/index.ts";
import { GateSite } from "../packages/engine/src/sites/gate.ts";
import { SandboxBrowsers } from "../packages/engine/src/sites/sandbox_browser.ts";
import { browserClickTool, browserOpenTool, type BrowserLanes, browserReadTool, browserTypeTool } from "../packages/engine/src/tools/browser.ts";
import type { ToolContext } from "../packages/engine/src/tools/types.ts";

const chrome = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	Bun.which("google-chrome") ?? undefined,
	Bun.which("google-chrome-stable") ?? undefined,
	Bun.which("chromium") ?? undefined,
].find((path) => path && existsSync(path));

const profile = mkdtempSync(join(tmpdir(), "el-chrome-"));
let browser: ChildProcess | undefined;
let devtools = "";

// Pages the sandbox browser opens: a form, a link that opens a new tab, and a confirm.
const site = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		const url = new URL(request.url);
		const page = (body: string) => new Response(`<!doctype html><html><head><title>${url.pathname === "/" ? "Plots" : "Second"}</title></head><body>${body}</body></html>`, { headers: { "content-type": "text/html" } });
		if (url.pathname === "/") {
			return page(`<h1>Field plots</h1><p>Yield by treatment.</p>
				<form action="/search"><input name="q" aria-label="Search plots"><button>Search</button></form>
				<a href="/second" target="_blank">Details</a>
				<button onclick="document.title = confirm('Delete everything?') ? 'deleted' : 'kept'">Delete</button>`);
		}
		if (url.pathname === "/search") return page(`<h1>Results for ${url.searchParams.get("q")}</h1>`);
		if (url.pathname === "/second") return page("<h1>Plot details</h1>");
		return new Response("", { status: 404 });
	},
});

// The stand-in lab: its port path to 9222 goes to Chrome, which starts on the first connection (one 502 first).
let started = false;
const seen = { auth: [] as string[], origin: [] as (string | null)[] };
const lab = Bun.serve<{ upstream?: WebSocket; queue: string[] }, never>({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request, server) {
		const url = new URL(request.url);
		seen.auth.push(request.headers.get("authorization") ?? "");
		if (request.headers.get("authorization") !== "Bearer test") return new Response("", { status: 401 });
		if (url.pathname === "/.well-known/enrichedlab-lab") return Response.json({ contract: "2026-11", name: "devlab", title: "Dev Lab", endpoints: { containers: true, ports: true }, sign_in: { kind: "oauth" }, browser: { protocol: "cdp", port: 9222, version: "test" } });
		if (url.pathname === "/v1/me") return Response.json({ subject: "u_1", handle: "pat", memberships: [], sandboxes: { enabled: true, network: "allowlist", hosts: ["127.0.0.1"] } });
		if (url.pathname === "/v1/models") return Response.json({ data: [] });
		if (url.pathname === "/v1/containers/c1") return Response.json({ id: "c1", status: "running" });
		if (url.pathname === "/v1/containers/c1/exec") return Response.json({ exit_code: 0, stdout: "", stderr: "" });
		const port = /^\/v1\/containers\/c1\/ports\/9222(\/.*)$/.exec(url.pathname);
		if (port) {
			if (!started) {
				started = true;
				return new Response("", { status: 502 });
			}
			const target = new URL(port[1]!, devtools);
			if (request.headers.get("upgrade") === "websocket") {
				seen.origin.push(request.headers.get("origin"));
				return server.upgrade(request, { data: { queue: [], upstream: undefined, target: target.href.replace(/^http/, "ws") } as never }) ? undefined : new Response("", { status: 400 });
			}
			// Gate's hop: Chrome answers only a loopback Host.
			return fetch(target, { headers: { host: target.host } });
		}
		return new Response("", { status: 404 });
	},
	websocket: {
		open(ws) {
			const upstream = new WebSocket((ws.data as unknown as { target: string }).target);
			ws.data.upstream = upstream;
			upstream.onopen = () => {
				for (const message of ws.data.queue) upstream.send(message);
				ws.data.queue = [];
			};
			upstream.onmessage = (event) => ws.send(String(event.data));
			upstream.onclose = () => ws.close();
		},
		message(ws, message) {
			const upstream = ws.data.upstream!;
			if (upstream.readyState === WebSocket.OPEN) upstream.send(String(message));
			else ws.data.queue.push(String(message));
		},
		close(ws) {
			ws.data.upstream?.close();
		},
	},
});

const pages: BrowserPageState[] = [];
const frames: BrowserFrame[] = [];
let gate: GateSite;
let browsers: SandboxBrowsers;
const base = `http://127.0.0.1:${lab.port}`;
const home = `http://127.0.0.1:${site.port}/`;

// Chrome starts before the tests are declared, so they skip where it's missing or can't start. (A CI Linux runner
// may not allow the user namespaces Chrome's own sandbox needs; this Chrome is a stand-in loading only local pages.)
if (chrome) {
	const linuxCi = process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : [];
	browser = spawn(chrome, ["--headless", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...linuxCi, "about:blank"], { stdio: "ignore" });
	for (let i = 0; i < 300 && !devtools; i++) {
		await Bun.sleep(50);
		const file = join(profile, "DevToolsActivePort");
		if (existsSync(file)) {
			const [port] = readFileSync(file, "utf8").split("\n");
			if (port?.trim()) devtools = `http://127.0.0.1:${port.trim()}`;
		}
	}
}

beforeAll(async () => {
	if (!devtools) return;
	gate = new GateSite({ name: "devlab", url: base, kind: "gate" }, { base, via: "key", headers: async () => ({ authorization: "Bearer test" }) }, "c1");
	await gate.connect();
	browsers = new SandboxBrowsers({
		connect: (_site, signal) => gate.cdp(signal),
		prepare: async () => undefined,
		lane: () => gate.browser(),
		title: () => "Dev Lab",
		emit: (name: string, params: never) => void (name === "browser.page" ? pages.push(params) : frames.push(params)),
	});
}, 30_000);

afterAll(async () => {
	await browsers?.closeAll();
	browser?.kill();
	lab.stop(true);
	site.stop(true);
	await Bun.sleep(200);
	rmSync(profile, { recursive: true, force: true });
});

const lanes = (sessionId: string, device = false): BrowserLanes => ({
	device: () => device,
	labs: () => {
		const lane = gate.browser();
		return lane ? [{ site: "devlab", title: "Dev Lab", network: lane.network, hosts: lane.hosts }] : [];
	},
	page: (s, signal) => browsers.page(sessionId, s, signal),
	last: () => browsers.lane(sessionId),
	remember: (where, s) => browsers.remember(sessionId, where, s),
});
const context = (sessionId: string, extra: Partial<ToolContext> = {}) => ({ sessionId, place: "local", signal: AbortSignal.timeout(60_000), vision: false, browser: lanes(sessionId), ...extra }) as unknown as ToolContext;

describe.skipIf(!devtools)("the browser in a lab's sandbox", () => {
	test("the descriptor and /v1/me say there's a browser and what it reaches", () => {
		expect(gate.browser()).toEqual({ version: "test", network: "allowlist", hosts: ["127.0.0.1"] });
	});

	test("the agent opens, reads, types and submits, through the lab's port path with its sign-in", async () => {
		const ctx = context("s1");
		const opened = await browserOpenTool.run({ url: home, where: "sandbox" }, ctx);
		expect(opened.content.split("\n")[0]).toBe("[In Dev Lab's sandbox browser, which reaches only 127.0.0.1.]");
		expect(opened.content).toContain(`Plots · ${home}`);
		expect(opened.content).toContain("# Field plots");
		expect(opened.content).toMatch(/\[1\] textbox "Search plots" \(empty\)/);
		// The DevTools socket went through the lab with the sign-in, and without an Origin header.
		expect(seen.origin.length).toBeGreaterThan(0);
		expect(seen.origin.every((o) => o === null)).toBe(true);
		// Read and type follow the lane used last without being told.
		const typed = await browserTypeTool.run({ ref: 1, text: "nitrogen", submit: true }, ctx);
		expect(typed.content).toContain("# Results for nitrogen");
		expect(pages.some((p) => p.sessionId === "s1" && p.url.includes("/search?q=nitrogen") && p.lab === "Dev Lab")).toBe(true);
	}, 60_000);

	test("a link that opens a new tab opens in the same page; a confirm is cancelled and reported", async () => {
		const ctx = context("s1");
		await browserOpenTool.run({ url: home }, ctx);
		const read = await browserReadTool.run({}, ctx);
		const details = Number(/\[(\d+)\] link "Details"/.exec(read.content)?.[1]);
		const next = await browserClickTool.run({ ref: details }, ctx);
		for (let i = 0; i < 40 && !(await browserReadTool.run({}, ctx)).content.includes("# Plot details"); i++) await Bun.sleep(100);
		expect((await browserReadTool.run({}, ctx)).content).toContain("# Plot details");
		expect(next.ok).toBe(true);
		await browserOpenTool.run({ url: home }, ctx);
		const page = (await browserReadTool.run({}, ctx)).content;
		const remove = Number(/\[(\d+)\] button "Delete"/.exec(page)?.[1]);
		const after = await browserClickTool.run({ ref: remove }, ctx);
		expect(after.content).toContain('The page showed a dialog: confirm "Delete everything?" (cancelled).');
		expect(after.content).toContain("kept · ");
	}, 60_000);

	test("a watching window gets frames and can click, type and go back as the person", async () => {
		const page = browsers.current("s1")!;
		await page.navigate({ url: home });
		await Bun.sleep(500);
		await page.watch(true);
		for (let i = 0; i < 50 && !frames.length; i++) await Bun.sleep(100);
		expect(frames[0]?.width).toBe(1280);
		expect(Buffer.from(frames[0]!.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
		await page.watch(false);
		// The person clicks into the search field and types.
		const field = await page.read();
		expect(field.text).toContain("Search plots");
		await page.click(1);
		await page.input({ kind: "text", text: "barley" });
		await page.input({ kind: "key", type: "keyDown", key: "Enter", code: "Enter" });
		await page.input({ kind: "key", type: "keyUp", key: "Enter", code: "Enter" });
		for (let i = 0; i < 40 && !(await page.info()).url.includes("q=barley"); i++) await Bun.sleep(100);
		expect((await page.info()).url).toContain("q=barley");
		await page.navigate({ step: "back" });
		for (let i = 0; i < 40 && (await page.info()).url !== home; i++) await Bun.sleep(100);
		expect((await page.info()).url).toBe(home);
	}, 60_000);

	test("a window that watches before any page opens gets pictures once one does", async () => {
		await browsers.watch("s4", true);
		await browserOpenTool.run({ url: home, where: "sandbox" }, context("s4"));
		for (let i = 0; i < 50 && !frames.some((f) => f.sessionId === "s4"); i++) await Bun.sleep(100);
		expect(frames.some((f) => f.sessionId === "s4")).toBe(true);
		await browsers.watch("s4", false);
		await browsers.close("s4");
	}, 60_000);

	test("sessions get separate browser contexts; closing one leaves the other", async () => {
		const other = context("s2");
		await browserOpenTool.run({ url: `${home}second`, where: "sandbox" }, other);
		const one = await browsers.page("s1", "devlab");
		const two = await browsers.page("s2", "devlab");
		expect(one).not.toBe(two);
		await browsers.close("s2");
		expect(browsers.current("s2")).toBeUndefined();
		expect((await one.info()).url).toBe(home);
	}, 60_000);

	test("an isolated lab's session uses only its own sandbox browser; without a lane named, the desktop's comes first", async () => {
		const sealed = await browserReadTool.run({}, context("s1", { sealed: true, place: "devlab" }));
		expect(sealed.content.startsWith("[In Dev Lab's sandbox browser")).toBe(true);
		const asked: string[] = [];
		const desktop = context("s3", { browser: lanes("s3", true), surface: { call: async (_c: string, op: string) => (asked.push(op), { text: "Desktop · https://example.org/" }) } } as Partial<ToolContext>);
		expect((await browserOpenTool.run({ url: "https://example.org/" }, desktop)).content).toBe("Desktop · https://example.org/");
		expect(asked).toEqual(["open"]);
	}, 60_000);
});
