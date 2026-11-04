// The browser in a lab's sandbox: the sandbox lane of the browser tools. The lab runs a headless Chrome in the
// person's sandbox and lists it in its descriptor (`browser: {protocol: "cdp", port}`); the engine drives it over the
// DevTools protocol through the lab's port path. Each session gets its own browser context (its own cookies,
// disposed with the connection), so sessions never share a sign-in, and the person's own logins stay in the desktop
// browser. Downloads land in the sandbox and leave only through the lab's scanned file API.
//
// A window that shows the session watches the page as a screencast and can click and type into it; what the agent
// does goes through the same calls as the desktop browser (page_script.mjs), so both lanes read pages the same way.

import { centerScript, focusScript, SNAPSHOT } from "../../../../apps/desktop/src/page_script.mjs";
import type { BrowserFrame, BrowserInput, BrowserPageState, SandboxNetwork } from "@enrichedlab/protocol";
import { sleep } from "../util.ts";
import type { Cdp } from "./cdp.ts";

export interface PageAnswer {
	text: string;
	image?: { mime: string; data: string };
}

/** What a lab's sandbox says about its browser and its reach. */
export interface SandboxBrowserLane {
	version?: string;
	network?: SandboxNetwork;
	hosts?: string[];
}

/** The page's size until a window says its pane's size, and the most a pane may ask for. */
const VIEWPORT = { width: 1280, height: 800 };
const LARGEST = { width: 1920, height: 1200 };
/** What Chrome says while a navigation replaces the page under a call: worth sending the call again. */
const TRANSIENT = /Not attached to an active page|Cannot find context|No frame (?:for|with) given id|Execution context was destroyed|Inspected target navigated/i;
/** Keys that need a key code to do anything (typing letters goes as text). */
const KEY_CODES: Record<string, number> = {
	Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
	ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};

/** One session's page in a lab's sandbox browser. */
export class SandboxPage {
	private loading = false;
	private dialog?: string;
	private watchers = 0;
	private stateTimer?: ReturnType<typeof setTimeout>;

	private constructor(
		private cdp: Cdp,
		readonly site: string,
		private target: string,
		private session: string,
		private context: string,
		private frame: string,
		private notify: { state(state: Omit<BrowserPageState, "sessionId" | "site" | "lab" | "network" | "hosts">): void; frame(frame: Omit<BrowserFrame, "sessionId">): void },
	) {}

	/** Make a browser context and a page in it over `cdp`, with downloads going to `downloads` in the sandbox. */
	static async open(cdp: Cdp, site: string, downloads: string, notify: SandboxPage["notify"]): Promise<SandboxPage> {
		const { browserContextId } = await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true });
		await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", browserContextId, downloadPath: downloads, eventsEnabled: true }).catch(() => undefined);
		const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId });
		const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
		await cdp.send("Page.enable", {}, sessionId);
		await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false }, sessionId);
		const tree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree", {}, sessionId);
		const page = new SandboxPage(cdp, site, targetId, sessionId, browserContextId, tree.frameTree.frame.id, notify);
		page.listen();
		await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
		return page;
	}

	get closed(): boolean {
		return Boolean(this.cdp.closed);
	}

	/** How many windows watch this page. */
	get watching(): number {
		return this.watchers;
	}

	private listen(): void {
		const mine = (session?: string) => session === this.session;
		this.cdp.on("Page.frameStartedLoading", (p, s) => {
			if (mine(s) && p.frameId === this.frame) (this.loading = true), this.changed();
		});
		this.cdp.on("Page.frameStoppedLoading", (p, s) => {
			if (mine(s) && p.frameId === this.frame) (this.loading = false), this.changed();
		});
		this.cdp.on("Page.frameNavigated", (p, s) => {
			if (mine(s) && !(p.frame as { parentId?: string }).parentId) this.changed();
		});
		// Headless pages stop at a dialog: an alert is accepted; a confirm or prompt is cancelled, so a click never
		// agrees to something on the person's behalf. The next read says what it asked.
		this.cdp.on("Page.javascriptDialogOpening", (p, s) => {
			if (!mine(s)) return;
			const type = String(p.type);
			this.dialog = `${type} "${String(p.message).slice(0, 300)}" (${type === "alert" || type === "beforeunload" ? "accepted" : "cancelled"})`;
			void this.cdp.send("Page.handleJavaScriptDialog", { accept: type === "alert" || type === "beforeunload" }, this.session).catch(() => undefined);
		});
		this.cdp.on("Page.screencastFrame", (p, s) => {
			if (!mine(s)) return;
			const meta = p.metadata as { deviceWidth: number; deviceHeight: number };
			this.notify.frame({ data: String(p.data), width: Math.round(meta.deviceWidth), height: Math.round(meta.deviceHeight) });
			void this.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.session).catch(() => undefined);
		});
		// A link that opens a new tab opens in this page instead: one page per session, the one the person sees.
		const popup = (p: Record<string, unknown>) => {
			const info = p.targetInfo as { targetId: string; type: string; openerId?: string; browserContextId?: string; url: string };
			if (info.type !== "page" || info.openerId !== this.target || info.browserContextId !== this.context) return;
			if (!info.url || info.url === "about:blank") return;
			void this.cdp.send("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined);
			void this.cdp.send("Page.navigate", { url: info.url }, this.session).catch(() => undefined);
		};
		this.cdp.on("Target.targetCreated", popup);
		this.cdp.on("Target.targetInfoChanged", popup);
	}

	/** Tell watching windows where the page is; several changes in a row send one update. */
	private changed(): void {
		if (this.stateTimer) return;
		this.stateTimer = setTimeout(async () => {
			this.stateTimer = undefined;
			const state = await this.info().catch(() => undefined);
			if (state) this.notify.state(state);
		}, 120);
	}

	async info(): Promise<{ url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }> {
		const [{ targetInfo }, history] = await Promise.all([
			this.cdp.send<{ targetInfo: { url: string; title: string } }>("Target.getTargetInfo", { targetId: this.target }),
			this.send<{ currentIndex: number; entries: unknown[] }>("Page.getNavigationHistory", {}),
		]);
		return { url: targetInfo.url, title: targetInfo.title, loading: this.loading, canBack: history.currentIndex > 0, canForward: history.currentIndex < history.entries.length - 1 };
	}

	/** Run a script in an isolated world of the page and return its value; again if a navigation replaced the page meanwhile. */
	private async evaluate<T>(expression: string): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				const { executionContextId } = await this.cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: this.frame, worldName: "el-agent" }, this.session);
				const result = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text?: string } }>(
					"Runtime.evaluate",
					{ expression, contextId: executionContextId, returnByValue: true },
					this.session,
				);
				if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "The page script failed.");
				return result.result.value as T;
			} catch (error) {
				if (attempt >= 5 || this.cdp.closed || !TRANSIENT.test((error as Error).message)) throw error;
				await sleep(200);
			}
		}
	}

	/** A call to this page, sent again (for about a second) while a navigation swaps the page underneath it. */
	private async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.cdp.send<T>(method, params, this.session);
			} catch (error) {
				if (attempt >= 5 || this.cdp.closed || !TRANSIENT.test((error as Error).message)) throw error;
				await sleep(200);
			}
		}
	}

	/** Wait a moment, then for the page to finish loading if it started (at most 15 seconds). */
	private async settle(ms: number): Promise<void> {
		await sleep(ms);
		if (!this.loading) return;
		await this.cdp.waitFor("Page.frameStoppedLoading", (p, s) => s === this.session && p.frameId === this.frame, 15_000);
		await sleep(300);
	}

	async read(): Promise<PageAnswer> {
		const [text, info] = await Promise.all([this.evaluate<string>(SNAPSHOT).catch(() => ""), this.info()]);
		const dialog = this.dialog ? `\n\nThe page showed a dialog: ${this.dialog}.` : "";
		this.dialog = undefined;
		return { text: `${info.title || "Untitled"} · ${info.url}\n\n${text || "(The page has no readable text; a PDF or a canvas may need browser_screenshot.)"}${dialog}` };
	}

	async open(url: string): Promise<PageAnswer> {
		const navigated = await this.send<{ errorText?: string }>("Page.navigate", { url });
		if (navigated.errorText) return { text: `Couldn't open ${url}: ${navigated.errorText}.` };
		await this.settle(400);
		return this.read();
	}

	async click(ref: number): Promise<PageAnswer> {
		const at = await this.evaluate<{ x: number; y: number } | null>(centerScript(ref));
		if (!at) throw new Error(`No control ${ref} on this page now; read it again.`);
		await this.mouse({ type: "mouseMoved", x: at.x, y: at.y });
		await this.mouse({ type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
		await this.mouse({ type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
		await this.settle(700);
		return this.read();
	}

	async type(ref: number, text: string, submit: boolean): Promise<PageAnswer> {
		if (!(await this.evaluate<boolean>(focusScript(ref)))) throw new Error(`No field ${ref} on this page now; read it again.`);
		await this.send("Input.insertText", { text });
		if (submit) await this.key({ type: "keyDown", key: "Enter", code: "Enter" }).then(() => this.key({ type: "keyUp", key: "Enter", code: "Enter" }));
		await this.settle(submit ? 900 : 200);
		return this.read();
	}

	async shot(): Promise<PageAnswer> {
		const [{ data }, info] = await Promise.all([this.send<{ data: string }>("Page.captureScreenshot", { format: "png" }), this.info()]);
		return { text: `${info.title} · ${info.url}`, image: { mime: "image/png", data } };
	}

	private mouse(event: { type: string; x: number; y: number; button?: string; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }) {
		return this.send("Input.dispatchMouseEvent", { button: "none", ...event, x: Math.round(event.x), y: Math.round(event.y) });
	}

	private key(event: { type: "keyDown" | "keyUp"; key: string; code?: string; modifiers?: number }) {
		const code = KEY_CODES[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0);
		// A key that types something carries its text on keyDown; the rest go as raw key presses.
		const typed = event.type === "keyDown" && ((event.modifiers ?? 0) & ~8) === 0 ? (event.key === "Enter" ? "\r" : event.key.length === 1 ? event.key : undefined) : undefined;
		return this.send(
			"Input.dispatchKeyEvent",
			{ type: event.type === "keyDown" ? (typed ? "keyDown" : "rawKeyDown") : "keyUp", key: event.key, code: event.code ?? "", windowsVirtualKeyCode: code, modifiers: event.modifiers ?? 0, ...(typed ? { text: typed } : {}) },
		);
	}

	/**
	 * Lay the page out to a watching window's pane (CSS pixels, within 320 by 240 and 1920 by 1200). Frames come at
	 * CSS size: headless Chrome's screencast ignores pixel density.
	 */
	async resize(width: number, height: number): Promise<void> {
		if (!Number.isFinite(width) || !Number.isFinite(height)) return;
		const size = { width: Math.round(Math.min(Math.max(width, 320), LARGEST.width)), height: Math.round(Math.min(Math.max(height, 240), LARGEST.height)) };
		await this.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
	}

	/** The person's own input from a window watching the page. */
	async input(event: BrowserInput): Promise<void> {
		switch (event.kind) {
			case "mouse":
				await this.mouse({ type: event.type, x: event.x, y: event.y, button: event.button ?? "left", clickCount: event.clickCount ?? 1, modifiers: event.modifiers });
				return;
			case "wheel":
				await this.mouse({ type: "mouseWheel", x: event.x, y: event.y, deltaX: event.deltaX, deltaY: event.deltaY });
				return;
			case "key":
				await this.key({ type: event.type, key: event.key, code: event.code, modifiers: event.modifiers });
				return;
			case "text":
				await this.send("Input.insertText", { text: event.text });
				return;
		}
	}

	/** The person moving the page from the window: an address, back, forward or reload. */
	async navigate(to: { url?: string; step?: "back" | "forward" | "reload" }): Promise<void> {
		if (to.url) {
			if (!/^(https?:\/\/|about:blank$)/.test(to.url)) throw new Error("Only http and https pages open here.");
			await this.send("Page.navigate", { url: to.url });
		} else if (to.step === "reload") await this.send("Page.reload", {});
		else if (to.step) {
			const history = await this.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory", {});
			const entry = history.entries[history.currentIndex + (to.step === "back" ? -1 : 1)];
			if (entry) await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
		}
	}

	/** A window starts or stops watching: the screencast runs while at least one does. A new watcher gets a picture at once. */
	async watch(on: boolean): Promise<void> {
		const before = this.watchers;
		this.watchers = Math.max(0, this.watchers + (on ? 1 : -1));
		if (on) await this.refresh();
		else if (before === 1 && this.watchers === 0) await this.cdp.send("Page.stopScreencast", {}, this.session).catch(() => undefined);
	}

	/** Start the screencast again: Chrome sends frames only when the page changes, and a fresh start sends one now. */
	async refresh(): Promise<void> {
		if (!this.watchers) return;
		await this.cdp.send("Page.stopScreencast", {}, this.session).catch(() => undefined);
		await this.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: LARGEST.width, maxHeight: LARGEST.height, everyNthFrame: 1 });
		this.changed();
	}

	async close(): Promise<void> {
		await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.context }, undefined, 5_000).catch(() => undefined);
		this.cdp.close();
	}
}

/** The sandbox pages of every session, and which browser each session used last. */
export class SandboxBrowsers {
	private pages = new Map<string, { site: string; page: Promise<SandboxPage> }>();
	private opened = new Map<string, SandboxPage>();
	private lanes = new Map<string, { where: "device" | "sandbox"; site?: string }>();
	/** Windows watching a session that has no page yet (or whose connection dropped): applied when one opens. */
	private wanted = new Map<string, number>();

	constructor(
		private deps: {
			/** A DevTools connection to the browser in `site`'s sandbox. */
			connect(site: string, signal?: AbortSignal): Promise<Cdp>;
			/** Make the folder downloads go to, in the sandbox. */
			prepare(site: string, dir: string, signal?: AbortSignal): Promise<void>;
			lane(site: string): SandboxBrowserLane | undefined;
			title(site: string): string;
			emit(name: "browser.page", params: BrowserPageState, sessionId: string): void;
			emit(name: "browser.frame", params: BrowserFrame, sessionId: string): void;
		},
	) {}

	/** The session's page in `site`'s sandbox browser, opened on first use and again after its connection dropped. */
	page(sessionId: string, site: string, signal?: AbortSignal): Promise<SandboxPage> {
		const kept = this.pages.get(sessionId);
		if (kept && kept.site === site && !this.opened.get(sessionId)?.closed) return kept.page;
		if (kept) void this.close(sessionId);
		const page = (async () => {
			const downloads = `/sandbox/downloads/${sessionId}`;
			await this.deps.prepare(site, downloads, signal).catch(() => undefined);
			const cdp = await this.deps.connect(site, signal);
			const lane = () => this.deps.lane(site) ?? {};
			const opened = await SandboxPage.open(cdp, site, downloads, {
				state: (state) => this.deps.emit("browser.page", { sessionId, site, lab: this.deps.title(site), network: lane().network, hosts: lane().hosts, ...state }, sessionId),
				frame: (frame) => this.deps.emit("browser.frame", { sessionId, ...frame }, sessionId),
			});
			cdp.onClose(() => {
				if (this.opened.get(sessionId) !== opened) return;
				this.opened.delete(sessionId);
				// The windows still watch: the next page this session opens starts its screencast for them.
				if (opened.watching) this.wanted.set(sessionId, opened.watching);
			});
			this.opened.set(sessionId, opened);
			for (let i = this.wanted.get(sessionId) ?? 0; i > 0; i--) await opened.watch(true);
			this.wanted.delete(sessionId);
			return opened;
		})();
		this.pages.set(sessionId, { site, page });
		page.catch(() => {
			if (this.pages.get(sessionId)?.page === page) this.pages.delete(sessionId);
		});
		return page;
	}

	/** The session's open page, for the person's input; undefined when none is open. */
	current(sessionId: string): SandboxPage | undefined {
		const page = this.opened.get(sessionId);
		return page && !page.closed ? page : undefined;
	}

	/** A window starts or stops watching the session's page; "again" asks for a fresh picture. */
	async watch(sessionId: string, on: boolean | "again"): Promise<SandboxPage | undefined> {
		const page = this.current(sessionId);
		if (page) {
			await (on === "again" ? page.refresh() : page.watch(on));
			return page;
		}
		if (on !== "again") this.wanted.set(sessionId, Math.max(0, (this.wanted.get(sessionId) ?? 0) + (on ? 1 : -1)));
		return undefined;
	}

	lane(sessionId: string): { where: "device" | "sandbox"; site?: string } | undefined {
		return this.lanes.get(sessionId);
	}

	remember(sessionId: string, where: "device" | "sandbox", site?: string): void {
		this.lanes.set(sessionId, { where, site });
	}

	async close(sessionId: string): Promise<void> {
		const kept = this.pages.get(sessionId);
		this.pages.delete(sessionId);
		this.opened.delete(sessionId);
		this.lanes.delete(sessionId);
		this.wanted.delete(sessionId);
		const page = await kept?.page.catch(() => undefined);
		await page?.close();
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.pages.keys()].map((id) => this.close(id)));
	}
}
