// The desktop window against a lab on this computer: a stand-in lab with a scripted model and a sandbox, a source
// engine on a throwaway home, and a git project with sessions in both places. For seeing every surface while
// changing it, and for checking the flows that cross between places.
//
//   bun scripts/dev_lab.ts --open            open the app on it, until the window closes
//   bun scripts/dev_lab.ts --shots <folder>  capture each scene in light and dark, and check the flows
//
// Development only. The stand-in sandbox is a temporary folder (its /sandbox paths are rewritten to it) and its
// commands run on this computer: the scripted model only asks for `uname`, `git log` and `ls`. Everything it makes is
// removed when it stops. Build the window first (bun run build:web): the source engine serves packages/web/dist.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineClient, findEngine } from "../packages/engine/src/index.ts";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const shotsAt = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1] ?? join(root, "dist", "shots")) : undefined;
const only = args.includes("--scene") ? args[args.indexOf("--scene") + 1] : undefined;
const work = mkdtempSync(join(tmpdir(), "el-dev-lab-"));
const home = join(work, "home");
const sandbox = join(work, "sandbox");
const project = join(work, "project");
const KEY = "dev-lab-key";

// ── The stand-in lab ─────────────────────────────────────────────────────────────────────────────────────────────

const toHost = (s: string) => s.replaceAll("/sandbox", sandbox);
const toLab = (s: string) => s.replaceAll(sandbox, "/sandbox");
const ANSWER = [
	"Both commands ran.",
	"",
	"| Check | Output |",
	"|---|---|",
	"| `uname -s` | the system's name |",
	"| `git log -1` | the commit that came along |",
	"",
	"The project has a **README** and one commit. Next I'd add a `tests/` folder:",
	"",
	"```sh",
	"mkdir -p tests && touch tests/test_basic.py",
	"```",
].join("\n");

type ChatBody = { messages: { role: string }[]; tools?: unknown[] };
function stream(chunks: unknown[]): Response {
	return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const usage = (input: number, output: number) => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } });

/** Chunks sent at a model's pace (about `perSecond`), as a real model streams a long tool call. */
function paced(chunks: unknown[], perSecond: number): Response {
	const encoder = new TextEncoder();
	let i = 0;
	const body = new ReadableStream({
		async pull(controller) {
			if (i >= chunks.length) {
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				return controller.close();
			}
			controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunks[i++])}\n\n`));
			await Bun.sleep(1000 / perSecond);
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A long page written as one tool call: about 30 KB of arguments, a few characters per chunk. */
function bigWrite(): Response {
	const page = `<!doctype html>\n<title>Dashboard</title>\n${Array.from({ length: 600 }, (_, i) => `<div class="row" data-i="${i}">row ${i}</div>`).join("\n")}\n`;
	const args = JSON.stringify({ path: "dashboard.html", content: page });
	const id = `call_${Date.now()}`;
	const pieces = args.match(/[\s\S]{1,12}/g)!;
	return paced(
		[
			delta({ content: "Writing the page now." }),
			delta({ tool_calls: [{ index: 0, id, type: "function", function: { name: "write", arguments: "" } }] }),
			...pieces.map((part) => delta({ tool_calls: [{ index: 0, function: { arguments: part } }] })),
			delta({}, "tool_calls"),
			usage(2000, pieces.length),
		],
		150,
	);
}

/** A request for commands runs one; the command's result gets the answer; a request without tools is the naming one. */
function reply(body: ChatBody): Response {
	if (!body.tools?.length) return stream([delta({ content: "Project check" }), delta({}, "stop"), usage(40, 3)]);
	const last = body.messages.at(-1) as { role: string; content?: unknown };
	if (last?.role === "user" && JSON.stringify(last.content ?? "").includes("big page")) return bigWrite();
	if (body.messages.at(-1)?.role === "user") {
		const call = { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "uname -s; git log --oneline -1; ls" }) } };
		return stream([delta({ reasoning_content: "The person wants commands run in the project; the shell tool does that." }), delta({ content: "I'll run that in the project." }), delta({ tool_calls: [call] }), delta({}, "tool_calls"), usage(1200, 40)]);
	}
	return stream([...ANSWER.match(/[\s\S]{1,40}/g)!.map((part) => delta({ content: part })), delta({}, "stop"), usage(1500, 120)]);
}

function mcp(message: { id?: number; method: string }): Response {
	if (message.id === undefined) return new Response(null, { status: 202 });
	const tool = { name: "datasets_search", description: "Search the lab's datasets by keyword.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, annotations: { readOnlyHint: true } };
	const result =
		message.method === "initialize"
			? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "devlab", version: "1" } }
			: message.method === "tools/list"
				? { tools: [tool] }
				: message.method === "tools/call"
					? { content: [{ type: "text", text: "3 datasets: soil_moisture_2026, canopy_temp, yield_trials" }] }
					: {};
	return Response.json({ jsonrpc: "2.0", id: message.id, result });
}

function listFiles(): { id: string; path: string; bytes: number }[] {
	const found: { id: string; path: string; bytes: number }[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const info = statSync(full);
			if (info.isDirectory()) walk(full);
			else found.push({ id: Buffer.from(toLab(full)).toString("base64url"), path: toLab(full), bytes: info.size });
		}
	};
	walk(join(sandbox, "work"));
	return found;
}

mkdirSync(join(sandbox, "work"), { recursive: true });
const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (request.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("", { status: 401 });
		if (path === "/v1/chat/completions" && request.method === "POST") {
			await Bun.sleep(300);
			return reply((await request.json()) as ChatBody);
		}
		if (path === "/mcp") return request.method === "POST" ? mcp((await request.json()) as { id?: number; method: string }) : new Response("", { status: 405 });
		if (path === "/.well-known/enrichedlab-lab") {
			return Response.json({ contract: "2026-11", name: "devlab", title: "Field Lab", endpoints: { models: true, containers: true }, sign_in: { kind: "cloudflare-access-oauth" }, policy: { keep_data_inside: false }, sandbox_networks: [{ name: "none", title: "No network" }] });
		}
		if (path === "/v1/me") return Response.json({ subject: "u_dev", handle: "pat", memberships: [{ lab: "devlab", research_group: null, roles: ["member"] }], policy: { keep_data_inside: false }, sandbox_networks: ["none"], sandboxes: { enabled: true } });
		if (path === "/v1/models") return Response.json({ data: [{ id: "field-coder", gate: { context: 131072, capabilities: ["reasoning", "tools"], efforts: ["low", "medium", "high"] } }] });
		if (path === "/v1/containers") return request.method === "POST" ? Response.json({ id: "c1", status: "running" }) : Response.json({ data: [{ id: "c1", status: "running", name: "EnrichedLab" }] });
		if (path === "/v1/containers/c1") return Response.json({ id: "c1", status: "running", image: null, network: null });
		if (path === "/v1/containers/c1/exec") {
			const { command, timeout_seconds } = (await request.json()) as { command: string; timeout_seconds?: number };
			const run = Bun.spawn(["sh", "-c", toHost(command)], { cwd: join(sandbox, "work"), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: sandbox } });
			const timer = setTimeout(() => run.kill(), (timeout_seconds ?? 120) * 1000);
			const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()]);
			clearTimeout(timer);
			return Response.json({ exit_code: await run.exited, stdout: toLab(stdout), stderr: toLab(stderr) });
		}
		if (path === "/v1/containers/c1/files" && request.method === "POST") {
			const file = (await request.formData()).get("file") as File;
			writeFileSync(join(sandbox, "work", file.name), Buffer.from(await file.arrayBuffer()));
			return Response.json({ path: `/sandbox/work/${file.name}`, bytes: file.size });
		}
		if (path === "/v1/containers/c1/files") return Response.json({ data: listFiles(), has_more: false });
		const content = /^\/v1\/containers\/c1\/files\/([^/]+)\/content$/.exec(path);
		if (content) return new Response(readFileSync(toHost(Buffer.from(content[1]!, "base64url").toString())));
		return new Response("", { status: 404 });
	},
});

// ── The engine, the project and its sessions ─────────────────────────────────────────────────────────────────────

mkdirSync(home, { recursive: true, mode: 0o700 });
writeFileSync(join(work, "lab.key"), KEY, { mode: 0o600 });
writeFileSync(join(home, "sites.json"), JSON.stringify({ sites: [{ name: "devlab", title: "Field Lab", url: "https://devlab.invalid", kind: "gate", lan: { url: `http://127.0.0.1:${lab.port}`, keyFile: join(work, "lab.key") }, preferLan: true }] }));
// A cloud service beside the lab (never called: its models are listed from config), so menus show both kinds.
writeFileSync(
	join(home, "config.json"),
	JSON.stringify({ model: "devlab/field-coder", discovery: { local: false }, providers: { cloudco: { api: "openai-chat", baseUrl: "https://api.cloudco.invalid/v1", keyEnv: "CLOUDCO_KEY", label: "CloudCo", models: ["cloud-large"] } } }),
);
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "README.md"), "# Soil moisture analysis\n\nScripts for the 2026 field season.\n");
writeFileSync(join(project, "src", "analysis.py"), "import pandas as pd\n\n\ndef load(path):\n    return pd.read_csv(path)\n");
writeFileSync(join(project, "plots.csv"), "plot,moisture\nP1,0.31\nP2,0.27\n");
const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=Pat", "-c", "user.email=pat@example.invalid", ...a], { cwd: project });
git("init", "-q");
git("add", ".");
git("commit", "-qm", "Start the field season scripts");

const env = { ...process.env, EL_HOME: home, EL_KEYSTORE: "file" };
const engine = Bun.spawn(["bun", join(root, "packages/cli/src/main.ts"), "serve", "--foreground"], { env, stdout: "ignore", stderr: "inherit" });
let app: ReturnType<typeof Bun.spawn> | undefined;
let failed = false;

async function main(): Promise<void> {
	process.env.EL_HOME = home;
	let found;
	for (let i = 0; i < 80 && !found; i++) {
		await Bun.sleep(250);
		found = await findEngine().catch(() => undefined);
	}
	if (!found) throw new Error("The engine didn't start.");
	const client = new EngineClient(found, "dev-lab");
	await client.ready();
	for (let i = 0; i < 40 && !(await client.call("site.list", {})).some((s) => s.sandbox); i++) await Bun.sleep(250);
	const turn = async (sessionId: string) => {
		let done = false;
		const stop = client.on("session.event", ({ sessionId: id, event }) => {
			if (id === sessionId && event.t === "assistant" && event.stop !== "tool_use") done = true;
		});
		await client.call("session.open", { sessionId });
		await client.call("session.prompt", { sessionId, text: "Run uname and show the last commit" });
		for (let i = 0; i < 120 && !done; i++) await Bun.sleep(250);
		stop();
		if (!done) throw new Error(`The seeded turn in ${sessionId} didn't finish.`);
	};
	const local = await client.call("session.create", { cwd: project });
	await turn(local.id);
	const moved = await client.call("session.create", { cwd: project });
	await client.call("session.place", { sessionId: moved.id, place: "devlab" });
	await turn(moved.id);
	console.log(`dev lab: engine on ${found.port}, lab on ${lab.port}, sessions ${local.id} (This Mac) and ${moved.id} (Field Lab)`);

	if (!shotsAt) {
		app = electron({}, ["--session", moved.id]);
		await app.exited;
		return;
	}
	mkdirSync(shotsAt, { recursive: true });
	for (const theme of ["light", "dark"] as const) {
		await client.call("ui.set", { theme });
		for (const scene of SCENES) {
			if (only && scene.name !== only) continue;
			const sessionId = scene.session === "lab" ? moved.id : scene.session === "local" ? local.id : undefined;
			const before = new Set((await client.call("session.list", {})).map((s) => s.id));
			const file = join(shotsAt, `${scene.name}-${theme}.png`);
			app = electron(
				{
					EL_SHOT: file,
					EL_SHOT_DELAY: "2500",
					EL_SHOT_AFTER: String(scene.after ?? 1200),
					EL_SHOT_SIZE: scene.size ?? "1360x880",
					...(scene.route ? { EL_SHOT_ROUTE: scene.route } : {}),
					...(scene.js ? { EL_SHOT_JS: `(() => { ${HELPERS} ${scene.js} })()` } : {}),
					...(scene.type ? { EL_SHOT_TYPE: scene.type } : {}),
					...(scene.menu ? { EL_SHOT_MENU: scene.menu } : {}),
					...(scene.resize ? { EL_SHOT_RESIZE: scene.resize } : {}),
				},
				sessionId ? ["--session", sessionId] : [],
			);
			const code = await Promise.race([app.exited, Bun.sleep(90_000).then(() => "timeout")]);
			if (code === "timeout") app.kill();
			const problem = scene.check ? await scene.check(client, before) : undefined;
			if (problem) failed = true;
			console.log(`${scene.name} (${theme}): ${problem ? `FAILED: ${problem}` : "ok"}`);
		}
	}
	client.close();
}

function electron(extra: Record<string, string>, argv: string[]): ReturnType<typeof Bun.spawn> {
	const bin = join(root, "apps/desktop/node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron");
	const proc = Bun.spawn([bin, ".", `--user-data-dir=${join(work, "electron")}`, "--use-mock-keychain", ...argv], { cwd: join(root, "apps/desktop"), env: { ...env, ...extra }, stdout: "pipe", stderr: "ignore" });
	// What a scene measured (shot: perf ...) goes to this script's output.
	void (async () => {
		for await (const line of proc.stdout.pipeThrough(new TextDecoderStream())) for (const l of line.split("\n")) if (l.startsWith("shot: perf")) console.log(`  ${l.slice(6)}`);
	})().catch(() => undefined);
	return proc;
}

// ── Scenes ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** In each scene's script: q(selector), button(label or text), later(ms, fn). */
const HELPERS = `const q = (s) => document.querySelector(s);
const button = (t) => [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === t || b.textContent.trim() === t);
const later = (ms, f) => setTimeout(f, ms);`;

interface Scene {
	name: string;
	session?: "lab" | "local";
	route?: string;
	js?: string;
	type?: string;
	menu?: string;
	size?: string;
	/** WxH: the window is resized back and forth to this size during the scene, then compared with the page. */
	resize?: string;
	after?: number;
	/** A problem with what the scene did, if any. `before` holds the sessions that existed before it. */
	check?: (client: EngineClient, before: Set<string>) => Promise<string | undefined>;
}

const SCENES: Scene[] = [
	{ name: "start", route: "/#/new", js: `q("#task-field")?.focus();` },
	{ name: "session_lab", session: "lab" },
	{ name: "session_local", session: "local" },
	{ name: "place_menu", session: "lab", js: `q(".switch .chip")?.click();` },
	{ name: "model_menu", session: "lab", js: `[...document.querySelectorAll(".model .chip")][0]?.click();` },
	{ name: "workbench_files", session: "local", after: 2500, js: `button("Workbench")?.click(); later(700, () => button("Files")?.click()); later(1800, () => [...document.querySelectorAll(".files-pane button")].find((b) => b.textContent.includes("README"))?.click());` },
	{ name: "workbench_terminal", session: "local", after: 2500, type: "ls", js: `button("Workbench")?.click(); later(700, () => button("Terminal")?.click()); later(2200, () => q(".xterm-helper-textarea")?.focus());` },
	// A terminal keeps running when its tab moves into a split: the text typed before the move is still there.
	{
		name: "terminal_split",
		session: "local",
		after: 7000,
		type: "echo still-here",
		js: `button("Workbench")?.click(); later(700, () => button("Files")?.click()); later(1200, () => button("Terminal")?.click()); later(2200, () => q(".xterm-helper-textarea")?.focus()); later(6500, () => { const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes("Terminal")); tab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true })); });`,
	},
	{ name: "settings", session: "lab", js: `button("Settings")?.click();` },
	{ name: "model_services", session: "lab", after: 2000, js: `button("Models")?.click();` },
	{ name: "palette", session: "lab", js: `q(".search")?.click();` },
	{ name: "join_lab", session: "lab", js: `button("Add a lab")?.click();` },
	{ name: "move_back", session: "lab", after: 2000, js: `q(".switch .chip")?.click(); later(500, () => q(".switch .menu-item")?.click());` },
	{ name: "narrow_900", session: "lab", size: "900x720" },
	{ name: "narrow_760", session: "lab", size: "760x700" },
	{ name: "compact_workbench", session: "local", size: "1100x800", after: 2000, js: `button("Workbench")?.click(); later(700, () => button("Files")?.click());` },
	// A long tool call streams for about 20 seconds: the page has to keep drawing frames (a window resized meanwhile
	// shows its old frame over the window's material until the page draws again).
	{
		name: "streaming_write",
		session: "local",
		after: 26_000,
		resize: "1000x640",
		type: "Write a big page",
		js: `const gaps = []; let last = performance.now(); let long = 0, longest = 0;
new PerformanceObserver((l) => l.getEntries().forEach((e) => { long += e.duration; longest = Math.max(longest, e.duration); })).observe({ type: "longtask", buffered: false });
const frame = (t) => { gaps.push(t - last); last = t; if (gaps.length < 100000) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
q("textarea")?.focus();
later(24_000, () => { const sorted = [...gaps].sort((a, b) => a - b); const p = (x) => sorted[Math.floor(sorted.length * x)]?.toFixed(1);
console.log("shot: perf frames " + gaps.length + " p50 " + p(0.5) + " ms p95 " + p(0.95) + " ms max " + sorted.at(-1)?.toFixed(0) + " ms; long tasks " + long.toFixed(0) + " ms, longest " + longest.toFixed(0) + " ms"); });`,
	},
	// A task typed after choosing "New Session in <lab>" from the lab's menu runs there as the first turn.
	{
		name: "new_in_lab",
		route: "/#/new",
		after: 9000,
		menu: "New Session in Field Lab",
		type: "Run uname and show the last commit",
		js: `[...document.querySelectorAll("button.place-main")].find((b) => b.textContent.includes("Field Lab"))?.click(); later(900, () => q("#task-field")?.focus());`,
		check: async (client, before) => {
			const made = (await client.call("session.list", {})).filter((s) => !before.has(s.id));
			if (made.length !== 1) return `expected one new session, found ${made.length}`;
			if (made[0]!.place !== "devlab") return `the session is on ${made[0]!.place ?? "This Mac"}, not the lab`;
			if (made[0]!.turns !== 1) return `the first task didn't run (${made[0]!.turns} turns)`;
			return undefined;
		},
	},
];

try {
	await main();
} catch (error) {
	console.error(`dev lab: ${(error as Error).message}`);
	failed = true;
} finally {
	app?.kill();
	engine.kill();
	await engine.exited;
	lab.stop(true);
	rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
process.exit(failed ? 1 : 0);
