// The desktop window, live: a test engine with one session, the app opened on it, the browser pane sent to a real
// page, and screenshots of the window and of the browser view. Run on each platform by .github/workflows/desktop.yml;
// locally: bun scripts/desktop_smoke.ts <out folder>.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineClient, findEngine } from "../packages/engine/src/index.ts";

const root = join(import.meta.dir, "..");
// Absolute, because the app runs from apps/desktop and writes its screenshots where this says.
const out = resolve(process.argv[2] ?? join(root, "dist", "smoke"));
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "el-smoke-"));
const project = mkdtempSync(join(tmpdir(), "el-smoke-project-"));
const env = { ...process.env, EL_HOME: home };
let app: ReturnType<typeof Bun.spawn> | undefined;
const engine = Bun.spawn(["bun", join(root, "packages/cli/src/main.ts"), "serve", "--foreground"], { env, stdout: "ignore", stderr: "inherit" });
try {
	process.env.EL_HOME = home;
	let found;
	for (let i = 0; i < 80 && !found; i++) {
		await Bun.sleep(250);
		found = await findEngine().catch(() => undefined);
	}
	if (!found) throw new Error("The engine didn't start.");
	const client = new EngineClient(found, "smoke");
	await client.ready();
	const session = await client.call("session.create", { cwd: project });
	client.close();
	console.log(`session ${session.id} in ${project}`);
	// In the window: open the workbench, its browser, and send it to a page.
	const scene = `(() => {
		const click = (test) => [...document.querySelectorAll("button")].find(test)?.click();
		click((b) => b.getAttribute("aria-label") === "Workbench");
		setTimeout(() => click((b) => b.textContent.trim() === "Browser"), 600);
		// Wait for the address field and focus it; the shell types the address into it (EL_SHOT_TYPE).
		const focus = (tries) => {
			const field = document.querySelector("input.address");
			if (!field) return tries > 0 && setTimeout(() => focus(tries - 1), 250);
			field.focus();
		};
		setTimeout(() => focus(40), 1200);
	})()`;
	const electron = join(root, "apps/desktop/node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron");
	const shot = join(out, `window-${process.platform}.png`);
	app = Bun.spawn([electron, ".", `--user-data-dir=${join(home, "electron")}`, "--use-mock-keychain", "--session", session.id], {
		cwd: join(root, "apps/desktop"),
		env: { ...env, EL_SHOT: shot, EL_SHOT_DELAY: "4000", EL_SHOT_AFTER: "7000", EL_SHOT_JS: scene, EL_SHOT_TYPE: "https://example.com/" },
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await Promise.race([app.exited, Bun.sleep(150_000).then(() => "timeout")]);
	if (code === "timeout") app.kill();
	await Bun.sleep(1500);
	if (!existsSync(shot)) throw new Error("The window wasn't captured.");
	const views = readdirSync(out).filter((f) => f.startsWith(`window-${process.platform}-browser-`) && f.endsWith(".json"));
	if (!views.length) throw new Error("No browser view was captured.");
	const page = JSON.parse(readFileSync(join(out, views[0]!), "utf8")) as { url: string; title: string };
	console.log(`browser view: ${page.url} "${page.title}"`);
	if (!/example\.com/.test(page.url) || !/Example Domain/.test(page.title)) throw new Error(`The browser pane didn't load the page (it shows ${page.url}).`);
	console.log("desktop smoke: window and browser pane OK");
} finally {
	app?.kill();
	engine.kill();
	await engine.exited;
	// Windows keeps the app's files locked for a moment after it exits; a cleanup failure never hides the result.
	for (const dir of [home, project]) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
		} catch (error) {
			console.warn(`couldn't remove ${dir}: ${(error as Error).message}`);
		}
	}
}
