// The EnrichedLab desktop window: a thin shell around the web surface the person's engine serves. It finds or starts
// the engine, trades the engine token for a one-time browser link, and opens it in a window with the platform's
// material behind the sidebar. Everything else lives in the engine and the web surface.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, session, shell, WebContentsView } from "electron";
import { centerScript, focusScript, SNAPSHOT } from "./page_script.mjs";

/** The person's EnrichedLab folder. Until the engine moves an older ~/.enriched, that is where it runs. */
const home = () => {
	if (process.env.EL_HOME) return process.env.EL_HOME;
	const current = join(homedir(), ".el");
	const old = join(homedir(), ".enriched");
	return !existsSync(current) && existsSync(join(old, "run", "engine.json")) ? old : current;
};
const engineFile = () => join(home(), "run", "engine.json");
const binary = process.platform === "win32" ? "el.exe" : "el";

/** The el binary: bundled with the app, else the one the installer put on PATH. */
function labBinary() {
	const bundled = join(process.resourcesPath ?? "", "bin", binary);
	if (existsSync(bundled)) return bundled;
	const candidates = [
		join(homedir(), ".local", "bin", binary),
		join(home(), "bin", binary),
		join(process.env.LOCALAPPDATA ?? "", "Programs", "EnrichedLab", "bin", binary),
	];
	return candidates.find((p) => existsSync(p)) ?? binary;
}

function readEngine() {
	try {
		const file = JSON.parse(readFileSync(engineFile(), "utf8"));
		process.kill(file.pid, 0);
		return file;
	} catch {
		return undefined;
	}
}

async function pairUrl(next) {
	let file = readEngine();
	if (!file) {
		spawn(labBinary(), ["serve"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		for (let i = 0; i < 150 && !file; i++) {
			await new Promise((r) => setTimeout(r, 100));
			file = readEngine();
		}
	}
	if (!file) throw new Error(`The engine didn't start. Run "el doctor" in a terminal.`);
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${file.port}/api/pair?next=${encodeURIComponent(next)}`, {
				method: "POST",
				headers: { authorization: `Bearer ${file.token}` },
			});
			if (response.ok) return (await response.json()).url;
		} catch {
			// Still starting.
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error("The engine didn't answer.");
}

function sessionArg(argv) {
	const i = argv.indexOf("--session");
	return i >= 0 && /^s[0-9a-z]+$/.test(argv[i + 1] ?? "") ? argv[i + 1] : undefined;
}

let window;
let engineOrigin;

/** True when `target` is on the engine's own origin (parsed, so "http://127.0.0.1:1@evil" doesn't count). */
function onEngine(target, path = "/") {
	try {
		const url = new URL(target);
		return url.origin === engineOrigin && !url.username && !url.password && url.pathname.startsWith(path);
	} catch {
		return false;
	}
}

/** Keep a window on the engine's pages; anything else opens in the person's browser. The origin is read at each
 * navigation, because a restarted engine listens on a new port. */
function guard(contents) {
	// Frames inside the window (app pages) stay on the engine or a loopback app server; nothing else loads there.
	contents.on("will-frame-navigate", (details) => {
		if (!details.isMainFrame && !onEngine(details.url) && !/^http:\/\/127\.0\.0\.1:\d+\//.test(details.url) && details.url !== "about:blank") details.preventDefault();
	});
	contents.on("will-navigate", (event, target) => {
		if (!onEngine(target)) {
			event.preventDefault();
			if (/^https?:/.test(target)) void shell.openExternal(target);
		}
	});
	contents.setWindowOpenHandler(({ url: target }) => {
		if (/^https?:/.test(target) && !onEngine(target)) void shell.openExternal(target);
		return { action: "deny" };
	});
}

/** Only the app's own top frame may ask for the microphone, camera, notifications or the clipboard (voice, later);
 * canvases and everything else are refused. Electron grants these by default otherwise. */
function permissions() {
	const ours = (contents, url) => contents === window?.webContents && Boolean(engineOrigin) && onEngine(url ?? "") && !onEngine(url ?? "", "/canvas/");
	const allowed = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);
	session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
		callback(allowed.has(permission) && details.isMainFrame !== false && ours(contents, details.requestingUrl));
	});
	session.defaultSession.setPermissionCheckHandler((contents, permission, origin) => allowed.has(permission) && ours(contents, `${origin}/`));
	// Model-written pages may not start downloads into the person's folders without asking where.
	session.defaultSession.on("will-download", (_event, item) => item.setSaveDialogOptions({ title: "Save download" }));
}

/** An invite link, enrichedlab://join?url=https://…&name=…&title=…: the window's "join a lab" sheet, which asks first. */
function inviteRoute(argv) {
	const link = argv.find((a) => typeof a === "string" && a.startsWith("enrichedlab://"));
	if (!link) return undefined;
	try {
		const invite = new URL(link);
		const lab = new URL(invite.searchParams.get("url") ?? "");
		if (invite.hostname !== "join" || lab.protocol !== "https:") return undefined;
		const q = new URLSearchParams({ url: lab.origin });
		for (const key of ["name", "title", "isolated"]) if (invite.searchParams.get(key)) q.set(key, invite.searchParams.get(key).slice(0, 60));
		return `/#/join?${q}`;
	} catch {
		return undefined;
	}
}

async function open(argv) {
	const sessionId = sessionArg(argv);
	const shotRoute = process.env.EL_SHOT ? process.env.EL_SHOT_ROUTE : undefined;
	const url = await pairUrl(shotRoute ?? inviteRoute(argv) ?? (sessionId ? `/#/s/${sessionId}` : "/"));
	const origin = new URL(url).origin;
	engineOrigin = origin;
	if (window && !window.isDestroyed()) {
		await window.loadURL(url);
		window.show();
		window.focus();
		return;
	}
	const mac = process.platform === "darwin";
	const win11 = process.platform === "win32";
	window = new BrowserWindow({
		// A screenshot run can ask for a window size (EL_SHOT_SIZE=1024x720) to check narrower layouts.
		width: Number(/^(\d+)x\d+$/.exec(process.env.EL_SHOT ? (process.env.EL_SHOT_SIZE ?? "") : "")?.[1]) || 1360,
		height: Number(/^\d+x(\d+)$/.exec(process.env.EL_SHOT ? (process.env.EL_SHOT_SIZE ?? "") : "")?.[1]) || 880,
		minWidth: 720,
		minHeight: 520,
		show: false,
		title: "EnrichedLab",
		titleBarStyle: mac ? "hiddenInset" : win11 ? "hidden" : "default",
		titleBarOverlay: win11 ? { color: "#00000000", symbolColor: nativeTheme.shouldUseDarkColors ? "#f2f2f2" : "#022851", height: 52 } : undefined,
		// Centered in the 52 px toolbar the sidebar draws under them.
		trafficLightPosition: mac ? { x: 20, y: 19 } : undefined,
		vibrancy: mac ? "sidebar" : undefined,
		visualEffectState: mac ? "followWindow" : undefined,
		backgroundMaterial: win11 ? "mica" : undefined,
		backgroundColor: mac || win11 ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
		webPreferences: {
			preload: join(import.meta.dirname, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: true,
		},
	});
	guard(window.webContents);
	window.webContents.on("context-menu", (_event, params) => textMenu(params));
	// In full screen the traffic lights hide, so the page drops the space it keeps for them.
	window.on("enter-full-screen", () => window.webContents.send("fullscreen", true));
	window.on("leave-full-screen", () => window.webContents.send("fullscreen", false));
	// Links leave the app. A canvas opens in a plain window of its own: no preload, so model-written pages never
	// reach the shell's bridge, and the same navigation rules.
	window.webContents.setWindowOpenHandler(({ url: target }) => {
		if (onEngine(target, "/canvas/")) {
			const view = new BrowserWindow({
				width: 900,
				height: 700,
				title: "EnrichedLab view",
				backgroundColor: nativeTheme.shouldUseDarkColors ? "#000000" : "#ffffff",
				webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
			});
			guard(view.webContents);
			void view.loadURL(target);
		} else if (/^https?:/.test(target)) void shell.openExternal(target);
		return { action: "deny" };
	});
	// A screenshot run shows the window without taking focus, so it never catches what the person is typing.
	window.once("ready-to-show", () => (process.env.EL_SHOT ? window.showInactive() : window.show()));
	// The engine stops after 30 idle minutes and gets a new port and key when it starts again: when the page can't
	// reach it, pair afresh instead of leaving the window on "Reconnecting".
	window.webContents.on("console-message", (details) => {
		if (String(details.message ?? "").includes("lab:engine-lost")) void open([]).catch(() => undefined);
	});
	await window.loadURL(url);
	if (process.env.EL_SHOT) {
		console.log(`shot: window loaded ${new URL(url).pathname}`);
		await new Promise((r) => setTimeout(r, Number(process.env.EL_SHOT_DELAY) || 2500));
		// A screenshot run can set the scene first (open a sheet, the palette, a pane).
		if (process.env.EL_SHOT_JS) {
			await window.webContents.executeJavaScript(process.env.EL_SHOT_JS).catch(() => undefined);
			// Then type, as key events into whatever the scene focused (a screenshot run's window has no OS focus).
			if (process.env.EL_SHOT_TYPE) {
				await new Promise((r) => setTimeout(r, 2500));
				for (const ch of process.env.EL_SHOT_TYPE) window.webContents.sendInputEvent({ type: "char", keyCode: ch });
				window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
				window.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
				window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
			}
			await new Promise((r) => setTimeout(r, Number(process.env.EL_SHOT_AFTER) || 900));
		}
		const image = await window.webContents.capturePage();
		const { writeFileSync } = await import("node:fs");
		writeFileSync(process.env.EL_SHOT, image.toPNG());
		console.log(`shot: window captured, ${views.size} browser ${views.size === 1 ? "view" : "views"}`);
		// Browser panes are native views over the page: each is captured on its own, with what it shows.
		let n = 0;
		for (const view of views.values()) {
			const shot = process.env.EL_SHOT.replace(/\.png$/, `-browser-${++n}.png`);
			writeFileSync(shot, (await view.webContents.capturePage()).toPNG());
			writeFileSync(shot.replace(/\.png$/, ".json"), JSON.stringify({ url: view.webContents.getURL(), title: view.webContents.getTitle() }));
		}
		app.quit();
	}
}

// ── Menus: the menu bar, right-click on text and links, and the page's own context menus ─────────────────────────
// Commands the page carries out go to it by id; the page owns what each one does.
// The page reports what applies now (a session open, a turn running, the sidebar shown), so items read and enable
// as they would in a native app.
let menuState = { session: false, busy: false, sidebar: true, workbench: false, undoable: false };

/** Send a command to the main window, opening it again first if it was closed. */
async function send(command) {
	if (!window || window.isDestroyed()) {
		await open([]);
		await new Promise((r) => setTimeout(r, 600));
	}
	window.show();
	window.webContents.send("command", command);
}

/** A menu item: in a view window, Close closes that window and the rest act on the main one. */
const item = (label, command, accelerator, enabled = true) => ({
	label,
	accelerator,
	enabled,
	click: (_item, focused) => {
		if (command === "close-pane" && focused && focused !== window) return focused.close();
		void send(command);
	},
});

function appMenu() {
	const mac = process.platform === "darwin";
	const template = [
		...(mac
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" },
							{ type: "separator" },
							item("Settings…", "settings", "CmdOrCtrl+,"),
							{ type: "separator" },
							{ role: "services" },
							{ type: "separator" },
							{ role: "hide" },
							{ role: "hideOthers" },
							{ role: "unhide" },
							{ type: "separator" },
							{ role: "quit" },
						],
					},
				]
			: []),
		{
			label: "File",
			submenu: [
				item("New Session", "new-session", "CmdOrCtrl+N"),
				item("New Terminal", "new-terminal", "Ctrl+`", menuState.session),
				{ type: "separator" },
				item("Add a Lab…", "add-lab"),
				item("Model Services…", "services"),
				{ type: "separator" },
				item("Close", "close-pane", "CmdOrCtrl+W"),
				...(mac ? [] : [{ type: "separator" }, item("Settings…", "settings", "CmdOrCtrl+,"), { role: "quit" }]),
			],
		},
		{ role: "editMenu" },
		{
			label: "View",
			submenu: [
				item("Search and Commands…", "palette", "CmdOrCtrl+K"),
				{ type: "separator" },
				item(menuState.sidebar ? "Hide Sidebar" : "Show Sidebar", "toggle-sidebar", mac ? "Ctrl+Cmd+S" : "Ctrl+Shift+S"),
				item(menuState.workbench ? "Hide Workbench" : "Show Workbench", "toggle-workbench", "CmdOrCtrl+\\", menuState.session),
				{ type: "separator" },
				{
					label: "Appearance",
					submenu: ["auto", "light", "dark"].map((theme) => ({
						label: theme === "auto" ? "Match System" : theme === "light" ? "Light" : "Dark",
						type: "radio",
						checked: currentTheme === theme,
						click: () => send(`theme-${theme}`),
					})),
				},
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
			],
		},
		{
			label: "Session",
			submenu: [
				item("Rename…", "rename", undefined, menuState.session),
				item("Stop", "stop", "CmdOrCtrl+.", menuState.busy),
				item("Summarize Older Turns", "compact", undefined, menuState.session && !menuState.busy),
				item("Undo File Changes", "undo-files", undefined, menuState.undoable && !menuState.busy),
				{ type: "separator" },
				item(mac ? "Show Project in Finder" : "Show Project Folder", "reveal", undefined, menuState.session),
			],
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [
				{ label: "EnrichedLab on GitHub", click: () => shell.openExternal("https://github.com/RichardStoker-USDA/enrichedlab-harness") },
				{ label: "What's New", click: () => shell.openExternal("https://github.com/RichardStoker-USDA/enrichedlab-harness/releases") },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.on("menu:state", (event, state) => {
	if (event.sender !== window?.webContents || typeof state !== "object" || !state) return;
	const next = { session: Boolean(state.session), busy: Boolean(state.busy), sidebar: state.sidebar !== false, workbench: Boolean(state.workbench), undoable: Boolean(state.undoable) };
	if (JSON.stringify(next) === JSON.stringify(menuState)) return;
	menuState = next;
	appMenu();
});

let currentTheme = "auto";
// The page's appearance choice drives the window material too, so a light page never sits on dark glass.
ipcMain.on("theme", (event, theme) => {
	if (event.sender !== window?.webContents || !["auto", "light", "dark"].includes(theme)) return;
	currentTheme = theme;
	nativeTheme.themeSource = theme === "auto" ? "system" : theme;
	appMenu();
});

/** Right-click on text, a text field, a link or an image: the system's own items. The page handles its other areas. */
function textMenu(params) {
	const items = [];
	const editable = params.isEditable;
	if (editable && params.misspelledWord) {
		for (const word of params.dictionarySuggestions.slice(0, 4)) items.push({ label: word, click: () => window.webContents.replaceMisspelling(word) });
		if (params.dictionarySuggestions.length) items.push({ type: "separator" });
		items.push({ label: "Learn Spelling", click: () => window.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord) }, { type: "separator" });
	}
	if (params.linkURL && /^https?:/.test(params.linkURL)) {
		items.push({ label: "Open Link in Browser", click: () => shell.openExternal(params.linkURL) }, { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
	}
	if (params.mediaType === "image" && params.srcURL) items.push({ label: "Copy Image", click: () => window.webContents.copyImageAt(params.x, params.y) }, { type: "separator" });
	if (editable) {
		items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
	} else if (params.selectionText.trim()) {
		items.push({ role: "copy" });
		if (process.platform === "darwin") items.push({ type: "separator" }, { label: `Look Up “${params.selectionText.trim().slice(0, 24)}${params.selectionText.trim().length > 24 ? "…" : ""}”`, click: () => window.webContents.showDefinitionForSelection() });
	}
	while (items.at(-1)?.type === "separator") items.pop();
	if (items.length) Menu.buildFromTemplate(items).popup({ window });
}

/** The page's own context menu (a session, a place, a tab, a file), shown natively. Resolves with the chosen id. */
ipcMain.handle("menu:popup", (event, entries, at) => {
	if (event.sender !== window?.webContents || !Array.isArray(entries)) return undefined;
	let budget = 400;
	return new Promise((resolve) => {
		let chosen;
		const build = (list, depth) =>
			list.slice(0, budget).flatMap((e) => {
				if (budget-- <= 0 || typeof e !== "object" || !e) return [];
				if (e.separator) return [{ type: "separator" }];
				const label = String(e.label ?? "").slice(0, 200);
				const base = { label, enabled: !e.disabled };
				if (Array.isArray(e.submenu) && depth < 3) return [{ ...base, submenu: build(e.submenu, depth + 1) }];
				const type = e.checked === undefined ? "normal" : e.radio ? "radio" : "checkbox";
				return [{ ...base, type, checked: Boolean(e.checked), click: () => (chosen = String(e.id ?? "").slice(0, 64)) }];
			});
		const options = { window, callback: () => resolve(chosen) };
		const x = Number(at?.x);
		const y = Number(at?.y);
		if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < 20000 && y < 20000) Object.assign(options, { x: Math.round(x), y: Math.round(y) });
		Menu.buildFromTemplate(build(entries, 0)).popup(options);
	});
});

ipcMain.on("window:close", (event) => {
	if (event.sender === window?.webContents) window.close();
});

ipcMain.handle("reveal", (event, path) => {
	if (event.sender !== window?.webContents || typeof path !== "string" || !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return false;
	shell.showItemInFolder(path);
	return true;
});

// ── The browser pane: real browser views laid over the pane's rectangle ──────────────────────────────────────────
// Each view browses in its own session ("persist:browser"), apart from the app's storage, with permission prompts
// (camera, microphone, location) refused. Only the app's own window can drive them.
const views = new Map();
const browsable = (url) => /^(https?:|about:blank$)/.test(url);
const fromApp = (event) => event.sender === window?.webContents;

let browsing;
function browserSession() {
	if (browsing) return browsing;
	browsing = session.fromPartition("persist:browser");
	browsing.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
	browsing.setPermissionCheckHandler(() => false);
	browsing.on("will-download", (_event, item) => item.setSaveDialogOptions({ title: "Save download" }));
	return browsing;
}

function report(id, view) {
	const contents = view.webContents;
	window?.webContents.send("browser:state", id, {
		url: contents.getURL(),
		title: contents.getTitle(),
		canGoBack: contents.navigationHistory.canGoBack(),
		canGoForward: contents.navigationHistory.canGoForward(),
		loading: contents.isLoading(),
		failed: failures.get(id),
	});
}

/** Why a view's last page didn't load, until the next one starts. */
const failures = new Map();

function browserView(id) {
	let view = views.get(id);
	if (view) return view;
	// plugins: Chromium's PDF viewer, so PDFs (forms included) open in the pane.
	view = new WebContentsView({ webPreferences: { session: browserSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true } });
	const contents = view.webContents;
	contents.setWindowOpenHandler(({ url: target }) => {
		if (/^https?:/.test(target)) void contents.loadURL(target);
		return { action: "deny" };
	});
	contents.on("will-navigate", (event, target) => !browsable(target) && event.preventDefault());
	// Right-click in the page: the system's text and link items, then Back, Forward and Reload.
	contents.on("context-menu", (_event, params) => {
		const items = [];
		if (params.linkURL && /^https?:/.test(params.linkURL)) items.push({ label: "Open Link Here", click: () => void contents.loadURL(params.linkURL) }, { label: "Open Link in Browser", click: () => shell.openExternal(params.linkURL) }, { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) }, { type: "separator" });
		if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { type: "separator" });
		else if (params.selectionText.trim()) items.push({ role: "copy" }, { type: "separator" });
		const history = contents.navigationHistory;
		items.push({ label: "Back", enabled: history.canGoBack(), click: () => history.goBack() }, { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() }, { label: "Reload", click: () => contents.reload() });
		Menu.buildFromTemplate(items).popup({ window });
	});
	for (const name of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading"]) contents.on(name, () => report(id, view));
	contents.on("did-start-loading", () => (failures.delete(id), report(id, view)));
	// A page that can't load says why (an aborted load, -3, is a person's Stop and isn't a failure).
	contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
		if (!mainFrame || code === -3) return;
		failures.set(id, { url, reason: description || `error ${code}` });
		report(id, view);
	});
	views.set(id, view);
	return view;
}

const rect = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });

ipcMain.on("browser:show", (event, id, url, bounds) => {
	if (!fromApp(event) || !window) return;
	const view = browserView(String(id));
	window.contentView.addChildView(view);
	view.setBounds(rect(bounds));
	view.setVisible(true);
	if (browsable(url) && url !== "about:blank" && view.webContents.getURL() !== url && !view.webContents.getURL()) void view.webContents.loadURL(url);
});
ipcMain.on("browser:bounds", (event, id, bounds) => fromApp(event) && views.get(String(id))?.setBounds(rect(bounds)));
ipcMain.on("browser:hide", (event, id) => fromApp(event) && views.get(String(id))?.setVisible(false));
ipcMain.on("browser:navigate", (event, id, url) => {
	if (fromApp(event) && browsable(url)) void browserView(String(id)).webContents.loadURL(url);
});
ipcMain.on("browser:go", (event, id, step) => {
	const contents = fromApp(event) ? views.get(String(id))?.webContents : undefined;
	if (!contents) return;
	if (step === "back") contents.navigationHistory.goBack();
	else if (step === "forward") contents.navigationHistory.goForward();
	else if (step === "stop") contents.stop();
	else contents.reload();
});
// ── The agent's hands in the browser pane ────────────────────────────────────────────────────────────────────────
// The page is read as text with numbered controls (page_script.mjs, shared with a lab sandbox's browser); clicks and
// typing are real input events, so pages behave as they do for a person. Scripts run in an isolated world.
const WORLD = 1001;

const settle = (contents, ms = 700) =>
	new Promise((resolve) => {
		let done = false;
		const finish = () => !done && ((done = true), resolve());
		setTimeout(() => (contents.isLoading() ? contents.once("did-stop-loading", () => setTimeout(finish, 300)) : finish()), ms);
		setTimeout(finish, 15_000);
	});

async function page(contents) {
	const text = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SNAPSHOT }]).catch(() => "");
	return { text: `${contents.getTitle() || "Untitled"} · ${contents.getURL()}\n\n${text || "(The page has no readable text; a PDF or a canvas may need browser_screenshot.)"}` };
}

async function center(contents, ref) {
	const box = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: centerScript(ref) }]);
	if (!box) throw new Error(`No control ${ref} on this page now; read it again.`);
	return box;
}

ipcMain.handle("browser:agent", async (event, id, op, args) => {
	if (!fromApp(event)) throw new Error("Not from the app.");
	let view = views.get(String(id));
	// A pane that just opened makes its view as it mounts.
	for (let i = 0; !view && i < 50; i++) await new Promise((r) => setTimeout(r, 100)), (view = views.get(String(id)));
	if (!view) throw new Error("The browser pane isn't open.");
	const contents = view.webContents;
	switch (op) {
		case "open": {
			if (!/^https?:/.test(String(args.url))) throw new Error("Only http and https pages open here.");
			await contents.loadURL(String(args.url)).catch(() => undefined);
			await settle(contents, 400);
			return page(contents);
		}
		case "read":
			return page(contents);
		case "click": {
			const { x, y } = await center(contents, args.ref);
			for (const type of ["mouseMove", "mouseDown", "mouseUp"]) contents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 });
			await settle(contents);
			return page(contents);
		}
		case "type": {
			const ok = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: focusScript(args.ref) }]);
			if (!ok) throw new Error(`No field ${args.ref} on this page now; read it again.`);
			contents.insertText(String(args.text ?? ""));
			if (args.submit) for (const type of ["keyDown", "char", "keyUp"]) contents.sendInputEvent({ type, keyCode: type === "char" ? "\r" : "Enter" });
			await settle(contents, args.submit ? 900 : 200);
			return page(contents);
		}
		case "shot": {
			let image = await contents.capturePage();
			if (image.getSize().width > 1280) image = image.resize({ width: 1280 });
			return { text: `${contents.getTitle()} · ${contents.getURL()}`, image: { mime: "image/png", data: image.toPNG().toString("base64") } };
		}
	}
	throw new Error(`Unknown browser action ${op}.`);
});

ipcMain.on("browser:close", (event, id) => {
	const view = fromApp(event) ? views.get(String(id)) : undefined;
	if (!view) return;
	window?.contentView.removeChildView(view);
	view.webContents.close();
	views.delete(String(id));
});

ipcMain.handle("pick-folder", async (event) => {
	if (event.sender !== window?.webContents) return undefined;
	const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
	return result.canceled ? undefined : result.filePaths[0];
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", (_event, argv) => void open(argv).catch((error) => dialog.showErrorBox("EnrichedLab", error.message)));
	// Invite links open here: macOS hands them over as open-url, Windows and Linux as an argument.
	if (app.isPackaged) app.setAsDefaultProtocolClient("enrichedlab");
	app.on("open-url", (event, link) => {
		event.preventDefault();
		if (app.isReady()) void open([link]).catch((error) => dialog.showErrorBox("EnrichedLab", error.message));
		else app.whenReady().then(() => open([link])).catch(() => undefined);
	});
	app.whenReady().then(() => appMenu());
	app.whenReady().then(() => permissions()).then(() => open(process.argv).catch((error) => {
		// A screenshot run has no one to close an error box: it says why on stderr and exits.
		if (process.env.EL_SHOT) {
			console.error(`shot: failed: ${error.stack ?? error.message}`);
			return app.exit(1);
		}
		dialog.showErrorBox("EnrichedLab", error.message);
		app.quit();
	}));
	app.on("activate", () => {
		if (!window || window.isDestroyed()) void open([]);
	});
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
}
