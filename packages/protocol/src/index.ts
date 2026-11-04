// The Lab protocol: what the engine and every surface (terminal, desktop, browser, editor bridge) say to each other.
// JSON-RPC 2.0 over a WebSocket on loopback. Surfaces import only this file from the engine side.

export const PROTOCOL_VERSION = 1;

// ── Content ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Part = { type: "text"; text: string } | { type: "image"; mime: string; data: string };

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON text as the model wrote it. */
	args: string;
}

export interface Usage {
	input: number;
	output: number;
	cached?: number;
	reasoning?: number;
}

export type StopReason = "end" | "tool_use" | "length" | "error" | "cancelled";

/** How a tool's call is shown: the verb and its target, as one step line. */
export interface StepView {
	verb: string;
	target: string;
	/** Short result for the right edge of the step line, e.g. "120 lines" or "exit 0". */
	result?: string;
	/** Longer output shown when the step is opened. */
	detail?: string;
	/** Unified diff for edits and writes. */
	diff?: string;
	/** A canvas the step published. */
	canvas?: string;
	/** A child session the step started (a subagent). */
	session?: string;
}

// ── Durable session events (one JSON object per line in the session log) ─────────────────────────────────────────

export interface EventBase {
	id: string;
	at: string;
}

export type SessionEvent =
	| (EventBase & {
			t: "header";
			v: 1;
			cwd: string;
			created: string;
			/** The system prompt, frozen for the session so prompt caches stay valid. */
			system?: string;
			/** The site this session is bound to: it sees only that site's tools and models. */
			site?: string;
			/** The session that started this one as a subagent, and what it may do. */
			parent?: string;
			mode?: "read" | "full";
			/** Set when the session works in its own git worktree: the repository, the worktree folder and its branch. */
			worktree?: { repo: string; path: string; branch: string };
	  })
	| (EventBase & { t: "user"; text: string; images?: Part[] })
	| (EventBase & {
			t: "assistant";
			model: string;
			text: string;
			reasoning?: string;
			/** Provider data needed to replay reasoning (e.g. a signature). Never shown. */
			reasoningData?: unknown;
			toolCalls?: ToolCall[];
			usage?: Usage;
			stop: StopReason;
			error?: string;
			ms?: number;
	  })
	| (EventBase & {
			t: "tool";
			callId: string;
			name: string;
			ok: boolean;
			/** What the model sees. */
			content: string;
			images?: Part[];
			view?: StepView;
			/** Handle of the full output when it was too large to keep inline. */
			handle?: string;
			decision?: "auto" | "allowed" | "allowed_session" | "denied" | "refused";
	  })
	| (EventBase & { t: "elide"; ids: string[]; tokensBefore: number })
	| (EventBase & { t: "compaction"; summary: string; firstKeptId: string; tokensBefore: number; model: string })
	| (EventBase & { t: "model"; model: string; effort?: string })
	| (EventBase & { t: "title"; title: string })
	| (EventBase & { t: "notice"; level: "info" | "warn" | "error"; text: string })
	/** Files as they were before a tool call changed them (see session.undo). */
	| (EventBase & {
			t: "checkpoint";
			callId: string;
			files: { path: string; existed: boolean; blob?: string }[];
			/** In a git repository: the working tree before the turn, as a commit on refs/enriched/checkpoints. */
			git?: string;
	  })
	/** File changes since the last message were put back. The model is told on its next request. */
	| (EventBase & {
			t: "undo";
			files: string[];
			/** True when a git snapshot restored the whole working tree, shell changes included. */
			all?: boolean;
	  })
	/** The session moved: files and commands now act in `root` at `place` ("local" or a site name). */
	| (EventBase & {
			t: "place";
			place: string;
			label: string;
			root: string;
			/** The repository came along: the commit sent, so new work can come back as a branch. */
			carried?: { repo: string; base: string; id: string };
			/** Where the session started (a site that keeps work in its sandbox); the system prompt already says so. */
			initial?: boolean;
	  })
	/** What an open app shows, sent by the app (MCP Apps ui/update-model-context). The model reads the latest. */
	| (EventBase & {
			t: "app_context";
			app: string;
			title: string;
			text: string;
	  });

export type SessionEventType = SessionEvent["t"];

// ── Live state ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Activity = "idle" | "thinking" | "writing" | "tool" | "waiting" | "compacting" | "retrying";

export interface ContextGauge {
	/** Tokens the next request is expected to carry. */
	used: number;
	/** Where automatic compaction starts. */
	threshold: number;
	window: number;
	/** True when `used` is an estimate (no provider count yet). */
	estimated: boolean;
}

export interface SessionStatus {
	sessionId: string;
	activity: Activity;
	/** Files the last turn changed that undo would put back; absent when nothing changed. */
	undoable?: string[];
	model: string;
	effort?: string;
	context: ContextGauge;
	/** Output tokens per second of the last response. */
	rate?: number;
	queued: number;
	detail?: string;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	title: string;
	created: string;
	updated: string;
	model: string;
	turns: number;
	running: boolean;
	site?: string;
	/** Set on subagent sessions: the session that started it. */
	parent?: string;
	/** Where its files and commands act: "local" or a site name. */
	place?: string;
}

// ── Models and sites ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelInfo {
	/** `<provider>/<model>` */
	ref: string;
	provider: string;
	id: string;
	label: string;
	source: "local" | "config" | "site";
	context: number;
	maxOutput: number;
	vision: boolean;
	efforts: string[];
	defaultEffort?: string;
}

/** An installed add-on: skills, instructions, MCP servers, hooks and model settings in one. */
export interface BundleSummary {
	name: string;
	version: string;
	description: string;
	/** A folder, an https git address, or "site:<name>" for one a site granted. */
	source: string;
	sha256: string;
}

export interface SiteSummary {
	name: string;
	/** What people see: the lab's name. */
	title: string;
	url: string;
	kind: string;
	/** Only sessions bound to it see its tools and models. */
	isolated?: boolean;
	signedIn: boolean;
	who?: string;
	via?: "oauth" | "key";
	models: number;
	tools: number;
	sandbox: boolean;
	error?: string;
	/** Connected, but something the person should know (for example: the browser sign-in was refused and the LAN key is in use). */
	warning?: string;
}

export interface PermissionRequest {
	requestId: string;
	sessionId: string;
	callId: string;
	tool: string;
	view: StepView;
	/** Why it asks, in plain words. */
	reason: string;
}

export type PermissionDecision = "allow" | "allow_session" | "deny";

export interface CanvasSummary {
	id: string;
	sessionId: string;
	title: string;
	/**
	 * html, markdown, svg, image: a document the engine serves at `url`. table and plot: data the surface draws
	 * itself from `source` (read with view.data). page: a running app at `href` (a Shiny or Streamlit app, a dev server).
	 */
	kind: "html" | "markdown" | "svg" | "image" | "table" | "plot" | "page";
	url: string;
	updated: string;
	version: number;
	/** The data file and where it lives ("local" or a site name), for table and plot. */
	source?: { path: string; place: string };
	/** Columns to draw, for plot. */
	plot?: { x: string; y: string; color?: string; type?: "scatter" | "line" };
	/** The app's address, for page. */
	href?: string;
}

// ── Apps ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// An app is a web page that runs in a workbench pane and reaches tools through its host, on the MCP Apps protocol
// (io.modelcontextprotocol/ui, 2026-01-26). Its backend, when it has one, is an MCP server: a module on the Bun
// runtime inside EnrichedLab, a program the person has, or a container. See docs/apps.md.

/** What an app may do beyond drawing itself. The person allows these when it first opens, and again if they grow. */
export interface AppPermissions {
	/** Read, or also change, files in the project of the session it opens in. */
	files?: "read" | "write";
	/** Run commands where that session works, contained like the agent's. */
	commands?: boolean;
	/** Ask the session's model. */
	models?: boolean;
	/** Run commands in these labs' sandboxes (site names). */
	labs?: string[];
	/** Origins the page and its backend may reach, such as "https://api.example.org". None by default. */
	network?: string[];
}

export interface AppSummary {
	id: string;
	name: string;
	title: string;
	version: string;
	description: string;
	/** Where its files are, for display. */
	dir: string;
	/** "project", "library", "bundle:<name>", or "mcp:<server>" for an MCP server's view. */
	source: string;
	backend?: "bun" | "command" | "container" | "serve";
	permissions: AppPermissions;
	/** True once the person has allowed its permissions (always true for an app that asks for none). */
	granted: boolean;
	/** Short fingerprint of the key that signed a packaged app. */
	signer?: string;
}

export interface AppToolResult {
	content: { type: string; text?: string; data?: string; mimeType?: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

/** What a surface answers when the engine asks it to act (the desktop's browser pane). */
export interface SurfaceAnswer {
	text: string;
	image?: { mime: string; data: string };
}

/** A model service someone can add with their own key. */
export interface ProviderPreset {
	id: string;
	label: string;
	api: "openai-chat" | "anthropic";
	baseUrl: string;
	keyUrl?: string;
	note: string;
}

/** What `update.check` found. `kind` is how this copy was installed. */
export interface UpdateStatus {
	current: string;
	latest?: string;
	security?: boolean;
	notes?: string[];
	kind: "mac-app" | "windows-app" | "appimage" | "binary" | "source";
	file?: string;
	checked?: string;
	error?: string;
}

// ── Requests (surface to engine) ─────────────────────────────────────────────────────────────────────────────────

export interface Requests {
	hello: { params: { client: string; version: string; capabilities?: string[] }; result: { engine: string; protocol: number; home: string; pid: number } };
	"session.list": { params: { cwd?: string; limit?: number }; result: SessionSummary[] };
	"session.create": { params: { cwd: string; model?: string; site?: string; worktree?: boolean }; result: SessionSummary };
	"session.open": {
		params: { sessionId: string };
		result: { summary: SessionSummary; events: SessionEvent[]; status: SessionStatus; pending: PermissionRequest[]; partial?: Partial_ };
	};
	"session.close": { params: { sessionId: string }; result: { ok: true } };
	"session.prompt": { params: { sessionId: string; text: string; images?: Part[] }; result: { queued: boolean } };
	"session.cancel": { params: { sessionId: string }; result: { ok: true } };
	"session.model": { params: { sessionId: string; model?: string; effort?: string }; result: SessionStatus };
	"session.compact": { params: { sessionId: string }; result: { ok: boolean; detail: string } };
	"session.undo": { params: { sessionId: string }; result: { ok: boolean; files: string[]; detail: string } };
	"session.rename": { params: { sessionId: string; title: string }; result: { ok: true } };
	/** Move where the session's files and commands act. A git repository comes along when `carry` is set. */
	"session.place": { params: { sessionId: string; place: string; carry?: boolean }; result: { summary: SessionSummary; detail: string } };
	"permission.answer": { params: { requestId: string; decision: PermissionDecision }; result: { ok: boolean } };
	"model.list": { params: { refresh?: boolean }; result: { models: ModelInfo[]; default?: string } };
	"model.default": { params: { model: string; effort?: string }; result: { ok: true } };
	/** Read config.json and installed bundles again, and connect or drop MCP servers to match. */
	"config.reload": { params: Record<string, never>; result: { bundles: BundleSummary[] } };
	"site.list": { params: Record<string, never>; result: SiteSummary[] };
	"site.add": { params: { name: string; url: string; title?: string; isolated?: boolean }; result: SiteSummary };
	"site.login": { params: { name: string }; result: SiteSummary };
	"site.logout": { params: { name: string }; result: { ok: true } };
	"site.refresh": { params: { name?: string }; result: SiteSummary[] };
	"canvas.list": { params: { sessionId?: string }; result: CanvasSummary[] };
	"ui.get": { params: Record<string, never>; result: UiPrefs };
	"ui.set": { params: Partial<UiPrefs>; result: UiPrefs };
	/** A folder where the session works (this computer or a lab sandbox). Paths are relative to its root. */
	"fs.list": { params: { sessionId: string; path?: string }; result: { root: string; place: string; entries: { name: string; type: "file" | "dir" | "link" | "other"; size: number }[] } };
	/** A text file's contents (up to 2 MB) where the session works. */
	"fs.read": { params: { sessionId: string; path: string }; result: { path: string; size: number; text?: string; binary?: boolean } };
	/** Open a file where the session works as a view: data as a table (or plot), images and HTML as shown. */
	"view.open": { params: { sessionId: string; path: string; plot?: CanvasSummary["plot"] }; result: CanvasSummary };
	/** The data behind a table or plot view: text for CSV, TSV and JSON; base64 for Parquet. */
	"view.data": { params: { canvasId: string }; result: { name: string; size: number; text?: string; base64?: string } };
	/** A terminal where the session works (or this computer without one): the person's shell, or a sandbox console. */
	"term.open": { params: { sessionId?: string; cwd?: string; cols: number; rows: number }; result: { termId: string; label: string } };
	"term.input": { params: { termId: string; data: string }; result: { ok: true } };
	"term.resize": { params: { termId: string; cols: number; rows: number }; result: { ok: true } };
	"term.close": { params: { termId: string }; result: { ok: true } };
	/** Remove a session and its log; refused while it runs. */
	"session.delete": { params: { sessionId: string }; result: { ok: true } };
	/** A surface's answer to surface.call. */
	"surface.reply": { params: { callId: string; result?: SurfaceAnswer; error?: string }; result: { ok: true } };
	/** Services `provider.add` knows, and the ones this person added. */
	"provider.list": { params: Record<string, never>; result: { presets: ProviderPreset[]; added: { name: string; label: string; baseUrl: string }[] } };
	/** Check a key against the service, keep it in the OS credential store, and offer the service's models. */
	"provider.add": { params: { preset: string; key: string; name?: string; baseUrl?: string }; result: { name: string; models: number } };
	"provider.remove": { params: { name: string }; result: { ok: true } };
	/** Whether a newer release is out (checked at most daily unless `force`). */
	"update.check": { params: { force?: boolean }; result: UpdateStatus };
	/** Download, verify and install the newer release. `restart` means the app should quit and start again. */
	"update.apply": { params: Record<string, never>; result: { version: string; restart: boolean } };
	"app.list": { params: Record<string, never>; result: AppSummary[] };
	/** Open an app for a session: a library app by id, or a folder with an app.json. The page lives at `url`. */
	"app.open": {
		params: { sessionId?: string; id?: string; path?: string };
		result: {
			app: AppSummary;
			token: string;
			/** Empty until the person allows what `asks` lists. */
			url: string;
			kind: "view" | "page";
			/** What the app asks for, in plain words, for the consent card. */
			asks: string[];
			toolInput?: Record<string, unknown>;
			toolResult?: AppToolResult;
		};
	};
	"app.grant": { params: { id: string; allow: boolean }; result: AppSummary };
	/** A tools/call from an open app: its backend's tools, or the host's lab_* tools its permissions allow. */
	"app.call": { params: { token: string; name: string; arguments?: Record<string, unknown> }; result: AppToolResult };
	/** ui/message: the app speaks for the person in its session. */
	"app.message": { params: { token: string; text: string }; result: { ok: true } };
	/** ui/update-model-context: what the app shows, for the model's next turn. */
	"app.context": { params: { token: string; text: string }; result: { ok: true } };
	"app.close": { params: { token: string }; result: { ok: true } };
	"engine.pair": { params: { next?: string }; result: { url: string } };
	"engine.stop": { params: Record<string, never>; result: { ok: true } };
}

/** What a surface needs to redraw a response that is still streaming when it attaches. */
export interface Partial_ {
	text: string;
	reasoning: string;
	tools: { index: number; name: string; args: string }[];
	/** Output so far of tools still running, by call id. */
	output: Record<string, string>;
}

export interface UiPrefs {
	theme: "auto" | "light" | "dark";
	showReasoning: boolean;
}

export type Method = keyof Requests;
export type Params<M extends Method> = Requests[M]["params"];
export type Result<M extends Method> = Requests[M]["result"];

// ── Notifications (engine to surface) ────────────────────────────────────────────────────────────────────────────

export interface Notifications {
	"session.event": { sessionId: string; event: SessionEvent };
	"session.delta": {
		sessionId: string;
		/** text and reasoning stream the answer; tool streams a call's arguments; output streams a running tool's output. */
		kind: "text" | "reasoning" | "tool" | "output";
		text: string;
		index?: number;
		name?: string;
		callId?: string;
	};
	"session.status": SessionStatus;
	"session.updated": SessionSummary;
	"permission.request": PermissionRequest;
	"permission.settled": { requestId: string; decision: PermissionDecision | "cancelled" };
	"site.auth": { name: string; url: string; instructions: string };
	"term.output": { termId: string; data: string };
	"term.exit": { termId: string; code: number | null };
	"site.updated": SiteSummary;
	"canvas.updated": CanvasSummary;
	/** An app's files changed: open views reload. */
	"app.changed": { id: string };
	/** The agent opened an app in a session: surfaces show it. */
	"app.opened": { sessionId: string; app: AppSummary };
	"ui.updated": UiPrefs;
	/** Something in this session needs a window (a plot, a table, an app, the browser) and none shows it. */
	"surface.wanted": { sessionId: string; reason: string };
	/** The engine asks one surface showing this session to act (`capability` as declared in hello). */
	"surface.call": { callId: string; sessionId: string; capability: string; op: string; args: Record<string, unknown> };
	/** A newer release is out; surfaces offer it. */
	"update.available": UpdateStatus;
}

export type Notification = keyof Notifications;

// ── Wire ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: unknown;
}

export interface RpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface RpcResponse {
	jsonrpc: "2.0";
	id: number | string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export const ErrorCodes = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	invalidParams: -32602,
	internal: -32603,
	busy: -32001,
	notFound: -32004,
	unauthorized: -32010,
} as const;

/** Where a running engine says it can be reached: `<home>/run/engine.json`. */
export interface EngineFile {
	pid: number;
	port: number;
	token: string;
	version: string;
	started: string;
	/** From a health check, not the file: a turn is running. */
	busy?: boolean;
}
