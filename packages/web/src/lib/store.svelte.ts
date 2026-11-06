// The web surface's state. Everything comes from the engine; this file mirrors it and sends requests. The workbench
// layout is the one piece kept here: it belongs to this person's screen, per session, in local storage.

import type { AppSummary, BrowserFrame, BrowserInput, BrowserPageState, CanvasSummary, DeviceRequest, LabApp, ModelInfo, Part, Partial_, PermissionDecision, PermissionRequest, SessionEvent, SessionStatus, SessionSummary, SiteSummary, UiPrefs } from "@enrichedlab/protocol";
import { close as closeTab, emptyLayout, move, type Node, open as openTab, resize as resizeSplit, revive, sync, type Edge, type PaneKind, type Tab, uid, activate, groups } from "./layout.ts";
import { placeOf, places, type Place } from "./places.ts";
import { rpc } from "./rpc.ts";

const emptyPartial = (): Partial_ => ({ text: "", reasoning: "", tools: [], output: {} });

const store = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string): void {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Private windows and blocked storage: the layout isn't remembered.
		}
	},
};

const TITLES: Record<PaneKind, string> = { view: "View", table: "Table", plot: "Plot", browser: "Browser", screen: "Sandbox browser", terminal: "Terminal", files: "Files", app: "App" };

class Lab {
	connected = $state(false);
	lost = $state(false);
	sessions = $state<SessionSummary[]>([]);
	sites = $state<SiteSummary[]>([]);
	/** The person's apps: the library, bundles, and project apps opened before. */
	apps = $state<AppSummary[]>([]);
	/** Apps the person's labs offer, every listed version (newest first per app). */
	labApps = $state<LabApp[]>([]);
	/** The open session's page in a lab's sandbox browser, as the engine last described it. */
	screen = $state<BrowserPageState | undefined>();
	private frames = new Set<(frame: BrowserFrame) => void>();
	/** Other devices asking to use the person's sign-in at a lab, oldest first; the window asks about each. */
	deviceRequests = $state<DeviceRequest[]>([]);
	/** Lab apps being installed, by "site/name". */
	installing = $state(new Set<string>());
	models = $state<ModelInfo[]>([]);
	ui = $state<UiPrefs>({ theme: "auto", showReasoning: true });
	current = $state<string | undefined>();
	summary = $state<SessionSummary | undefined>();
	events = $state<SessionEvent[]>([]);
	status = $state<SessionStatus | undefined>();
	partial = $state<Partial_>(emptyPartial());
	pending = $state<PermissionRequest[]>([]);
	canvases = $state<CanvasSummary[]>([]);
	flash = $state<string | undefined>();
	/** A page the flash points to, opened with its link. */
	flashUrl = $state<string | undefined>();
	/** Set when a compaction lands, so the context ring can sweep once. */
	compactedAt = $state(0);
	/** The workbench: open or not, and its panes for the current session. */
	workbench = $state(false);
	layout = $state<Node>(emptyLayout());
	/** A move between places is running (it can carry a repository). */
	moving = $state<string | undefined>();
	palette = $state(false);
	/** The model services sheet (add a key for OpenAI, Gemini and the like). */
	services = $state(false);
	/** An invite being joined (from an enrichedlab://join link or "Add a lab"). */
	join = $state<{ url?: string; name?: string; title?: string; isolated?: boolean } | undefined>();
	private flashTimer?: ReturnType<typeof setTimeout>;

	get busy(): boolean {
		return Boolean(this.status && this.status.activity !== "idle");
	}

	get model(): ModelInfo | undefined {
		return this.models.find((m) => m.ref === this.status?.model);
	}

	get places(): Place[] {
		return places(this.sites);
	}

	/** Where the open session works. */
	get place(): Place {
		return placeOf(this.places, this.summary?.place);
	}

	/** A lab that keeps its sessions' work in its sandbox can't be left. */
	get pinned(): boolean {
		const site = this.summary?.site;
		return Boolean(site && this.sites.find((s) => s.name === site)?.isolated);
	}

	/** A short message at the bottom of the window; one with a page to open stays longer. */
	say(text: string, url?: string): void {
		this.flash = text;
		this.flashUrl = url;
		clearTimeout(this.flashTimer);
		this.flashTimer = setTimeout(() => ((this.flash = undefined), (this.flashUrl = undefined)), url ? 20_000 : 6_000);
	}

	async init(): Promise<void> {
		rpc.onState = (connected, reconnected) => {
			this.connected = connected;
			this.lost = !connected;
			// Inside the desktop app this window can drive its browser pane for the agent.
			if (connected) void rpc.call("hello", { client: "web", version: "1", capabilities: window.labDesktop?.browser?.agent ? ["browser"] : [] }).catch(() => undefined);
			if (connected && reconnected) void this.reload();
		};
		this.listen();
		rpc.connect();
		await this.reload();
		window.addEventListener("hashchange", () => void this.route());
		await this.route();
	}

	private async reload(): Promise<void> {
		const [sessions, sites, ui, models, apps] = await Promise.all([
			rpc.call("session.list", { limit: 200 }),
			rpc.call("site.list", {}),
			rpc.call("ui.get", {}),
			rpc.call("model.list", {}),
			rpc.call("app.list", {}).catch(() => []),
		]);
		void rpc
			.call("lab.apps", {})
			.then((offered) => (this.labApps = offered))
			.catch(() => undefined);
		this.sessions = sessions;
		this.sites = sites;
		this.apps = apps;
		this.ui = ui;
		this.models = models.models;
		if (this.current) await this.open(this.current);
	}

	private async route(): Promise<void> {
		const match = /^#\/s\/(s[0-9a-z]+)/.exec(location.hash);
		if (match) {
			if (match[1] !== this.current) await this.open(match[1]);
		} else if (location.hash.startsWith("#/join")) {
			// An invite: the desktop app turns enrichedlab://join?… into this route.
			const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
			this.join = { url: q.get("url") ?? "", name: q.get("name") ?? undefined, title: q.get("title") ?? undefined, isolated: q.get("isolated") === "1" };
			history.replaceState(null, "", this.current ? `#/s/${this.current}` : "#/new");
		} else if (location.hash === "#/new") {
			this.leave();
		} else if (this.sessions[0] && !this.current) {
			location.hash = `#/s/${this.sessions[0].id}`;
		}
	}

	go(id: string): void {
		location.hash = `#/s/${id}`;
	}

	/** The new-session screen. */
	startNew(): void {
		location.hash = "#/new";
	}

	private leave(): void {
		if (this.current) void rpc.call("session.close", { sessionId: this.current }).catch(() => undefined);
		this.current = undefined;
		this.summary = undefined;
		this.events = [];
		this.status = undefined;
		this.pending = [];
		this.canvases = [];
		this.screen = undefined;
		this.layout = emptyLayout();
	}

	/** While a session opens, what arrives for it waits here and joins after the snapshot, without repeats. */
	private opening?: { id: string; events: SessionEvent[]; requests: PermissionRequest[] };
	/** When the open session loaded; steps logged before it render without the enter motion. */
	openedAt = 0;

	async open(id: string): Promise<void> {
		if (this.current && this.current !== id) void rpc.call("session.close", { sessionId: this.current }).catch(() => undefined);
		this.opening = { id, events: [], requests: [] };
		try {
			const snap = await rpc.call("session.open", { sessionId: id });
			const held = this.opening;
			this.opening = undefined;
			if (this.current !== id) this.screen = undefined;
			this.current = id;
			this.openedAt = Date.now();
			this.summary = snap.summary;
			const known = new Set(snap.events.map((e) => e.id));
			this.events = [...snap.events, ...(held?.id === id ? held.events.filter((e) => !known.has(e.id)) : [])];
			this.status = snap.status;
			const asked = new Set(snap.pending.map((p) => p.requestId));
			this.pending = [...snap.pending, ...(held?.id === id ? held.requests.filter((r) => !asked.has(r.requestId)) : [])];
			this.partial = snap.partial ?? emptyPartial();
			this.canvases = await rpc.call("canvas.list", { sessionId: id });
			this.restoreLayout(id);
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	// ── Workbench ──────────────────────────────────────────────────────────────────────────────────────────────────

	private restoreLayout(id: string): void {
		const saved = store.get(`enrichedlab.layout.${id}`);
		let layout: Node = emptyLayout();
		try {
			if (saved) layout = revive(JSON.parse(saved));
		} catch {
			// A damaged layout starts fresh.
		}
		layout = sync(layout, new Map(this.canvases.map((c) => [c.id, c.title])));
		// A session with views and no saved layout opens all of them, newest in front.
		if (!saved) for (const view of [...this.canvases].reverse().slice(-8)) layout = openTab(layout, this.tabFor(view));
		this.layout = layout;
		const wide = window.matchMedia("(min-width: 1180px)").matches;
		this.workbench = wide && (store.get(`enrichedlab.bench.${id}`) ?? (groups(layout).some((g) => g.tabs.length) ? "1" : "0")) === "1";
	}

	private saveLayout(): void {
		if (!this.current) return;
		store.set(`enrichedlab.layout.${this.current}`, JSON.stringify(this.layout));
		store.set(`enrichedlab.bench.${this.current}`, this.workbench ? "1" : "0");
	}

	setLayout(layout: Node): void {
		this.layout = layout;
		this.saveLayout();
	}

	toggleWorkbench(open = !this.workbench): void {
		this.workbench = open;
		this.saveLayout();
	}

	tabFor(view: CanvasSummary): Tab {
		const kind: PaneKind = view.kind === "table" ? "table" : view.kind === "plot" ? "plot" : view.kind === "page" ? "browser" : "view";
		return { id: uid("t"), kind, title: view.title, ref: kind === "browser" ? view.href : view.id };
	}

	/** Open a pane (or bring it forward) and show the workbench. */
	openPane(kind: PaneKind, ref?: string, title?: string): string {
		const view = ref ? this.canvases.find((c) => c.id === ref) : undefined;
		// Files, and each lab's sandbox browser, are one pane each: opening again brings it forward.
		const openFiles = (kind === "files" && !ref) || kind === "screen" ? groups(this.layout).flatMap((g) => g.tabs).find((t) => t.kind === kind && (kind === "files" || t.ref === ref)) : undefined;
		if (openFiles) {
			this.focusPane(openFiles.id);
			this.workbench = true;
			this.saveLayout();
			return openFiles.id;
		}
		const tab: Tab = view ? this.tabFor(view) : { id: uid("t"), kind, title: title ?? TITLES[kind], ref };
		// Terminals and browsers are new each time; views and files come forward if open.
		const fresh = (kind === "terminal" || kind === "browser") && !ref ? { ...tab, id: uid("t") } : tab;
		this.layout = kind === "terminal" ? openTab(this.layout, { ...fresh, ref: fresh.id }) : openTab(this.layout, fresh);
		this.workbench = true;
		this.saveLayout();
		return fresh.id;
	}

	/** The agent's use of the browser pane: open (or reuse) one and let the desktop shell act on its page. */
	private async browse(call: { callId: string; op: string; args: Record<string, unknown> }): Promise<void> {
		const agent = window.labDesktop?.browser?.agent;
		try {
			if (!agent) throw new Error("This window has no browser.");
			let tab = groups(this.layout).flatMap((g) => g.tabs).find((t) => t.kind === "browser");
			if (!tab && call.op !== "open") throw new Error("No page is open; use browser_open first.");
			if (!tab) {
				const id = this.openPane("browser", "about:blank", "Browser");
				tab = groups(this.layout).flatMap((g) => g.tabs).find((t) => t.id === id)!;
			} else this.focusPane(tab.id);
			this.workbench = true;
			const result = await agent(tab.id, call.op, call.args);
			await rpc.call("surface.reply", { callId: call.callId, result });
		} catch (error) {
			await rpc.call("surface.reply", { callId: call.callId, error: (error as Error).message }).catch(() => undefined);
		}
	}

	/** Start or stop the screencast of the session's sandbox browser page; answers where the page is. */
	async watchScreen(on: boolean): Promise<void> {
		if (!this.current) return;
		const answer = await rpc.call("browser.watch", { sessionId: this.current, on }).catch(() => ({ page: undefined }));
		if (on && answer.page) this.screen = answer.page;
	}

	onFrame(listener: (frame: BrowserFrame) => void): () => void {
		this.frames.add(listener);
		return () => this.frames.delete(listener);
	}

	/** The pane's size: the page lays out to it, so it fills the pane at full sharpness. */
	screenResize(width: number, height: number): void {
		if (this.current) void rpc.call("browser.resize", { sessionId: this.current, width, height }).catch(() => undefined);
	}

	screenInput(event: BrowserInput): void {
		if (this.current) void rpc.call("browser.input", { sessionId: this.current, event }).catch(() => undefined);
	}

	async screenNavigate(site: string, to: { url?: string; step?: "back" | "forward" | "reload" }): Promise<void> {
		if (!this.current) return;
		try {
			await rpc.call("browser.navigate", { sessionId: this.current, site, ...to });
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	closePane(tabId: string): void {
		this.setLayout(closeTab(this.layout, tabId));
		if (!groups(this.layout).some((g) => g.tabs.length)) this.toggleWorkbench(false);
	}

	focusPane(tabId: string): void {
		this.setLayout(activate(this.layout, tabId));
	}

	movePane(tabId: string, groupId: string, edge: Edge): void {
		this.setLayout(move(this.layout, tabId, groupId, edge));
	}

	resizeSplit(splitId: string, sizes: number[]): void {
		this.setLayout(resizeSplit(this.layout, splitId, sizes));
	}

	/** Open an app in the workbench: by id, as the agent or the palette names it. */
	openApp(app: AppSummary): void {
		if (!this.apps.some((a) => a.id === app.id)) this.apps = [...this.apps, app];
		this.openPane("app", app.id, app.title);
	}

	async refreshApps(): Promise<void> {
		const [apps, offered] = await Promise.all([rpc.call("app.list", {}).catch(() => this.apps), rpc.call("lab.apps", {}).catch(() => this.labApps)]);
		this.apps = apps;
		this.labApps = offered;
	}

	/** What each lab offers that isn't installed at its newest version: one entry per app. */
	get labOffers(): LabApp[] {
		const seen = new Set<string>();
		return this.labApps.filter((a) => {
			const key = `${a.site}/${a.name}`;
			if (seen.has(key) || a.withdrawn || a.signerRevoked) return false;
			seen.add(key);
			return a.installed !== a.version;
		});
	}

	/** Install (or update) an app from a lab's list, then open it. */
	async installLabApp(app: LabApp): Promise<void> {
		const key = `${app.site}/${app.name}`;
		this.installing = new Set([...this.installing, key]);
		try {
			const summary = await rpc.call("lab.app.install", { site: app.site, name: app.name, version: app.version });
			await this.refreshApps();
			this.say(`Installed ${summary.title} ${summary.version} from ${app.lab}.`);
			this.openApp(summary);
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.installing = new Set([...this.installing].filter((k) => k !== key));
		}
	}

	/** Point at a view's step: open its pane. */
	showView(id: string): void {
		const view = this.canvases.find((c) => c.id === id);
		if (view) this.openPane(this.tabFor(view).kind, view.kind === "page" ? view.href : view.id);
	}

	async openFile(path: string): Promise<void> {
		if (!this.current) return;
		try {
			const view = await rpc.call("view.open", { sessionId: this.current, path });
			this.upsertView(view);
			this.showView(view.id);
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	private upsertView(view: CanvasSummary): boolean {
		const first = !this.canvases.some((c) => c.id === view.id);
		this.canvases = [view, ...this.canvases.filter((c) => c.id !== view.id)];
		this.layout = sync(this.layout, new Map(this.canvases.map((c) => [c.id, c.title])));
		return first;
	}

	// ── Session actions ────────────────────────────────────────────────────────────────────────────────────────────

	async movePlace(place: string): Promise<void> {
		if (!this.current || this.moving) return;
		this.moving = place;
		try {
			const result = await rpc.call("session.place", { sessionId: this.current, place });
			this.upsert(result.summary);
			this.say(result.detail);
		} catch (error) {
			this.say((error as Error).message);
		} finally {
			this.moving = undefined;
		}
	}

	async undo(): Promise<void> {
		if (!this.current) return;
		const result = await rpc.call("session.undo", { sessionId: this.current });
		this.say(result.detail);
	}

	/** Start a session; `site` binds it to one lab (an isolated lab also keeps its work there). */
	async create(cwd: string, options: { site?: string; place?: string; worktree?: boolean } = {}): Promise<string | undefined> {
		try {
			let summary = await rpc.call("session.create", { cwd, site: options.site, worktree: options.worktree });
			if (options.place && options.place !== "local" && summary.place !== options.place) {
				const moved = await rpc.call("session.place", { sessionId: summary.id, place: options.place });
				summary = moved.summary;
			}
			this.upsert(summary);
			this.go(summary.id);
			await this.open(summary.id);
			return summary.id;
		} catch (error) {
			this.say((error as Error).message);
			return undefined;
		}
	}

	async send(text: string, images?: Part[]): Promise<void> {
		if (!this.current) return;
		await rpc.call("session.prompt", { sessionId: this.current, text, images });
	}

	cancel(): void {
		if (this.current) void rpc.call("session.cancel", { sessionId: this.current });
	}

	async answer(requestId: string, decision: PermissionDecision): Promise<void> {
		this.pending = this.pending.filter((p) => p.requestId !== requestId);
		await rpc.call("permission.answer", { requestId, decision });
	}

	async setModel(model?: string, effort?: string): Promise<void> {
		if (!this.current) return;
		try {
			this.status = await rpc.call("session.model", { sessionId: this.current, model, effort });
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	async compact(): Promise<void> {
		if (!this.current) return;
		const result = await rpc.call("session.compact", { sessionId: this.current });
		this.say(result.detail);
	}

	async rename(title: string): Promise<void> {
		if (this.current && title.trim()) await rpc.call("session.rename", { sessionId: this.current, title: title.trim() });
	}

	async refreshModels(): Promise<void> {
		this.models = (await rpc.call("model.list", { refresh: true })).models;
		this.sites = await rpc.call("site.list", {});
	}

	async login(name: string): Promise<void> {
		try {
			const site = await rpc.call("site.login", { name });
			this.say(site.signedIn ? `Signed in to ${site.title} as ${site.who}.` : `Not signed in: ${site.error}`);
			await this.refreshModels();
		} catch (error) {
			this.say((error as Error).message);
		}
	}

	async setTheme(theme: UiPrefs["theme"]): Promise<void> {
		this.ui = await rpc.call("ui.set", { theme });
	}

	private upsert(summary: SessionSummary): void {
		const rest = this.sessions.filter((s) => s.id !== summary.id);
		this.sessions = [summary, ...rest].sort((a, b) => b.updated.localeCompare(a.updated));
		if (summary.id === this.current) this.summary = summary;
	}

	private listen(): void {
		rpc.on("session.event", ({ sessionId, event }) => {
			if (sessionId === this.opening?.id) return void this.opening.events.push(event);
			if (sessionId !== this.current) return;
			if (this.events.at(-1)?.id === event.id || this.events.some((e) => e.id === event.id)) return;
			this.events.push(event);
			if (event.t === "assistant") this.partial = emptyPartial();
			if (event.t === "compaction") this.compactedAt = Date.now();
		});
		rpc.on("session.delta", (delta) => {
			if (delta.sessionId !== this.current) return;
			const p = this.partial;
			if (delta.kind === "text") p.text += delta.text;
			else if (delta.kind === "reasoning") p.reasoning += delta.text;
			else if (delta.kind === "tool") {
				if (delta.name !== undefined) p.tools.push({ index: delta.index ?? 0, name: delta.name, args: "" });
				else {
					const call = p.tools.find((c) => c.index === delta.index);
					if (call) call.args += delta.text;
				}
			} else if (delta.kind === "output" && delta.callId) {
				p.output[delta.callId] = ((p.output[delta.callId] ?? "") + delta.text).slice(-20_000);
			}
		});
		rpc.on("session.status", (status) => {
			if (status.sessionId !== this.current) return;
			this.status = status;
			if (status.activity === "idle") this.partial = emptyPartial();
		});
		rpc.on("session.updated", (summary) => this.upsert(summary));
		rpc.on("surface.call", (call) => {
			if (call.capability === "browser") void this.browse(call);
		});
		rpc.on("permission.request", (request) => {
			if (request.sessionId === this.opening?.id) return void this.opening.requests.push(request);
			if (request.sessionId === this.current && !this.pending.some((p) => p.requestId === request.requestId)) this.pending.push(request);
		});
		rpc.on("permission.settled", ({ requestId }) => {
			this.pending = this.pending.filter((p) => p.requestId !== requestId);
		});
		rpc.on("site.updated", (site) => {
			const known = this.sites.some((s) => s.name === site.name);
			this.sites = known ? this.sites.map((s) => (s.name === site.name ? site : s)) : [...this.sites, site];
		});
		rpc.on("lab.notice", (notice) => this.say(notice.text, notice.url));
		rpc.on("lab.apps.changed", () => void this.refreshApps());
		rpc.on("lab.device.pending", (request) => {
			if (!this.deviceRequests.some((r) => r.site === request.site && r.id === request.id)) this.deviceRequests = [...this.deviceRequests, request];
		});
		rpc.on("provider.auth", (auth) => {
			window.open(auth.url, "_blank", "noopener");
		});
		rpc.on("site.auth", (auth) => {
			window.open(auth.url, "_blank", "noopener");
			this.say(`Sign in to ${auth.name} in the browser window that opened. The first time, it may ask you to set up a second step: a passkey, a security key or an authenticator app.`);
		});
		rpc.on("canvas.updated", (view) => {
			if (view.sessionId !== this.current) return;
			// A new view opens as a tab, and the workbench opens for it; an update refreshes in place.
			if (this.upsertView(view)) {
				this.layout = openTab(this.layout, this.tabFor(view));
				this.workbench = true;
				this.saveLayout();
			}
		});
		rpc.on("ui.updated", (ui) => (this.ui = ui));
		// The agent's page in a lab's sandbox browser: its pane opens on the first sign of it.
		rpc.on("browser.page", (page) => {
			if (page.sessionId !== this.current) return;
			const fresh = this.screen?.site !== page.site;
			this.screen = page;
			// The first sign of the agent browsing there brings the pane forward, opening the workbench if needed.
			if (fresh) this.openPane("screen", page.site, `${page.lab} browser`);
		});
		rpc.on("browser.frame", (frame) => {
			if (frame.sessionId === this.current) for (const listener of this.frames) listener(frame);
		});
		rpc.on("app.opened", ({ sessionId, app }) => {
			if (sessionId === this.current) this.openApp(app);
		});
	}
}

export const lab = new Lab();

/** Where a person reviews and limits their ChatGPT plan's use in other apps. */
export const USAGE_URL = "https://chatgpt.com/settings/usage";
