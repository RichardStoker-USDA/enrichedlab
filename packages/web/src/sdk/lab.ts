// lab.js: what an EnrichedLab app imports. The engine bundles this file and serves it at /app-sdk/lab.js.
//
//   import { connect, scatter } from "/app-sdk/lab.js";
//   const lab = await connect({ name: "yield-explorer", version: "0.1.0" });
//   const table = await lab.table("plots.csv");
//
// It is a thin layer on the MCP Apps SDK (the App class, also served raw at /app-sdk/app.js): the handshake, the
// host's theme, and the host's lab_* tools by name. The plot renderer and table reader are the workbench's own.

import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { readTable, type Table } from "../lib/data.ts";
import { CATEGORY, createRenderer, hex, ramp, ticks, type Renderer, type View } from "../lib/plot.ts";

export { CATEGORY, createRenderer, hex, ramp, readTable, ticks };
export type { Renderer, Table, View };

export interface Entry {
	name: string;
	type: "file" | "dir" | "link" | "other";
	size: number;
}

export interface Lab {
	/** The MCP Apps connection, for anything below doesn't cover. */
	app: App;
	/** Call a tool: the app's own backend tools, or the host's lab_* tools. Returns structured data, or text. */
	call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
	files: {
		read(path: string): Promise<string>;
		bytes(path: string): Promise<Uint8Array>;
		list(path?: string): Promise<Entry[]>;
		write(path: string, text: string): Promise<void>;
	};
	/** A CSV, TSV, JSON, JSON Lines or Parquet file as typed columns. */
	table(path: string): Promise<Table>;
	/** A command where the session works, contained like the agent's. */
	run(command: string): Promise<{ exitCode: number | null; output: string }>;
	/** One answer from the session's model. */
	ask(prompt: string, system?: string): Promise<string>;
	/** A command in a lab's sandbox, such as lab.cluster("enrichedlab", "nvidia-smi"). */
	cluster(lab: string, command: string): Promise<{ exitCode: number | null; output: string }>;
	/** Small values kept for this app between visits. */
	store: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
	session(): Promise<{ project: string; place: string; model?: string }>;
	/** Speak in the session as the person (ui/message). */
	say(text: string): Promise<void>;
	/** Tell the model what the app shows, for its next turn (ui/update-model-context). */
	share(text: string): Promise<void>;
	/** Open an address beside the app. */
	open(url: string): Promise<void>;
	onInput(handler: (args: Record<string, unknown>) => void): void;
	onResult(handler: (result: { content?: unknown[]; structuredContent?: unknown }) => void): void;
}

type ToolOutput = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };

const text = (r: ToolOutput) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

/** Connect to the host. Call once, before anything else; the page takes the host's theme and keeps it. */
export async function connect(info: { name?: string; version?: string } = {}): Promise<Lab> {
	const app = new App({ name: info.name ?? (document.title || "app"), version: info.version ?? "0.0.0" }, {}, { autoResize: false });
	const theme = (ctx: ReturnType<App["getHostContext"]>) => {
		if (!ctx) return;
		if (ctx.theme) applyDocumentTheme(ctx.theme);
		if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
		if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
	};
	app.onhostcontextchanged = (changed) => theme({ ...app.getHostContext(), ...changed });
	await app.connect();
	theme(app.getHostContext());
	// Errors the page doesn't catch go to the host, which shows them and tells the agent.
	const report = (what: unknown) => void app.sendLog({ level: "error", data: what instanceof Error ? `${what.message}\n${what.stack ?? ""}`.slice(0, 2_000) : String(what) }).catch(() => undefined);
	addEventListener("error", (event) => report(event.error ?? event.message));
	addEventListener("unhandledrejection", (event) => report(event.reason));

	async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
		const result = (await app.callServerTool({ name, arguments: args })) as ToolOutput;
		if (result.isError) throw new Error(text(result) || `${name} failed.`);
		return (result.structuredContent ?? text(result)) as T;
	}
	const unbase = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

	return {
		app,
		call,
		files: {
			read: async (path) => {
				const r = await call<{ text?: string; base64?: string }>("lab_read_file", { path });
				return r.text ?? new TextDecoder().decode(unbase(r.base64 ?? ""));
			},
			bytes: async (path) => {
				const r = await call<{ text?: string; base64?: string }>("lab_read_file", { path, encoding: "base64" });
				return r.base64 !== undefined ? unbase(r.base64) : new TextEncoder().encode(r.text ?? "");
			},
			list: async (path = ".") => (await call<{ entries: Entry[] }>("lab_list_files", { path })).entries,
			write: async (path, body) => void (await call("lab_write_file", { path, text: body })),
		},
		table: async (path) => {
			const binary = /\.parquet$/i.test(path);
			const r = await call<{ text?: string; base64?: string }>("lab_read_file", { path, encoding: binary ? "base64" : "text" });
			return readTable({ name: path, text: r.text, base64: r.base64 });
		},
		run: (command) => call("lab_run", { command }),
		ask: async (prompt, system) => (await call<{ text: string }>("lab_ask", { prompt, system })).text,
		cluster: (lab, command) => call("lab_cluster_run", { lab, command }),
		store: {
			get: async <T>(key: string) => (await call<{ value?: T }>("lab_store_get", { key })).value,
			set: async (key, value) => void (await call("lab_store_set", { key, value })),
		},
		session: () => call("lab_session"),
		say: async (body) => void (await app.sendMessage({ role: "user", content: [{ type: "text", text: body }] })),
		share: async (body) => void (await app.updateModelContext({ content: [{ type: "text", text: body }] })),
		open: async (url) => void (await app.openLink({ url })),
		onInput: (handler) => void (app.ontoolinput = (params) => handler((params.arguments ?? {}) as Record<string, unknown>)),
		onResult: (handler) => void (app.ontoolresult = (params) => handler(params as { content?: unknown[]; structuredContent?: unknown })),
	};
}

/** The WebGPU device when this browser has one, for apps that draw or compute on the GPU themselves. */
export async function gpu(): Promise<{ adapter: GPUAdapter; device: GPUDevice; format: GPUTextureFormat } | undefined> {
	const nav = navigator as Navigator & { gpu?: GPU };
	if (!nav.gpu) return undefined;
	const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
	if (!adapter) return undefined;
	return { adapter, device: await adapter.requestDevice(), format: nav.gpu.getPreferredCanvasFormat() };
}

export interface ScatterOptions {
	x: Float32Array | number[];
	y: Float32Array | number[];
	/** Per point: a category label (colored from CATEGORY) or a number (colored on a ramp). */
	color?: (string | number | null)[];
	line?: boolean;
	xLabel?: string;
	yLabel?: string;
}

/**
 * An interactive scatter or line plot in `host` (an element with a size): WebGPU where the browser has it, Canvas 2D
 * otherwise. Drag pans, the wheel zooms, a double click resets. Returns update and destroy.
 */
export async function scatter(host: HTMLElement, options: ScatterOptions): Promise<{ update(next: ScatterOptions): void; destroy(): void; backend: string }> {
	const pad = { left: 52, right: 12, top: 10, bottom: 34 };
	host.style.position ||= "relative";
	const data = document.createElement("canvas");
	const axes = document.createElement("canvas");
	for (const c of [data, axes]) Object.assign(c.style, { position: "absolute", left: "0", top: "0" });
	Object.assign(data.style, { left: `${pad.left}px`, top: `${pad.top}px`, cursor: "grab", touchAction: "none" });
	axes.style.pointerEvents = "none";
	host.append(data, axes);
	const renderer = await createRenderer(data);
	let home: View = { x0: 0, x1: 1, y0: 0, y1: 1 };
	let view = home;
	let count = 0;
	let labels = { x: options.xLabel ?? "", y: options.yLabel ?? "" };

	function load(o: ScatterOptions) {
		const xs = Float32Array.from(o.x);
		const ys = Float32Array.from(o.y);
		count = xs.length;
		labels = { x: o.xLabel ?? "", y: o.yLabel ?? "" };
		const color = new Float32Array(count * 4);
		const numeric = o.color?.find((v) => v !== null && v !== undefined);
		const values = o.color ?? [];
		let lo = Infinity;
		let hi = -Infinity;
		if (typeof numeric === "number") for (const v of values) if (typeof v === "number") (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
		const cats = new Map<string, number>();
		const alpha = count > 200_000 ? 0.45 : count > 20_000 ? 0.7 : 0.9;
		for (let i = 0; i < count; i++) {
			const v = values[i];
			let rgb: [number, number, number];
			if (typeof v === "number") rgb = ramp((v - lo) / (hi - lo || 1));
			else if (typeof v === "string") {
				if (!cats.has(v)) cats.set(v, cats.size);
				rgb = hex(CATEGORY[cats.get(v)! % CATEGORY.length]!);
			} else rgb = hex(CATEGORY[0]!);
			color.set([...rgb, alpha], i * 4);
		}
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (let i = 0; i < count; i++) (x0 = Math.min(x0, xs[i]!)), (x1 = Math.max(x1, xs[i]!)), (y0 = Math.min(y0, ys[i]!)), (y1 = Math.max(y1, ys[i]!));
		const mx = (x1 - x0 || 1) * 0.04;
		const my = (y1 - y0 || 1) * 0.06;
		home = view = { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my };
		renderer.setData({ x: xs, y: ys, color, line: o.line === true });
	}

	function draw() {
		const dpr = devicePixelRatio || 1;
		const W = host.clientWidth;
		const H = host.clientHeight;
		const w = Math.max(1, W - pad.left - pad.right);
		const h = Math.max(1, H - pad.top - pad.bottom);
		renderer.resize(w, h, dpr);
		Object.assign(data.style, { width: `${w}px`, height: `${h}px` });
		axes.width = W * dpr;
		axes.height = H * dpr;
		Object.assign(axes.style, { width: `${W}px`, height: `${H}px` });
		renderer.draw(view, count > 100_000 ? 2 : count > 10_000 ? 3 : 4.5);
		const ctx = axes.getContext("2d")!;
		const style = getComputedStyle(host);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.font = `11px ${style.getPropertyValue("--font-sans") || "system-ui"}`;
		ctx.fillStyle = style.getPropertyValue("--color-text-secondary") || "#6b6b6b";
		ctx.strokeStyle = style.getPropertyValue("--color-border-secondary") || "rgba(128,128,128,0.25)";
		const px = (v: number) => pad.left + ((v - view.x0) / (view.x1 - view.x0)) * w;
		const py = (v: number) => pad.top + h - ((v - view.y0) / (view.y1 - view.y0)) * h;
		ctx.textAlign = "center";
		for (const t of ticks(view.x0, view.x1)) {
			ctx.beginPath(), ctx.moveTo(Math.round(px(t)) + 0.5, pad.top), ctx.lineTo(Math.round(px(t)) + 0.5, pad.top + h), ctx.stroke();
			ctx.fillText(String(+t.toPrecision(6)), px(t), pad.top + h + 15);
		}
		ctx.textAlign = "right";
		for (const t of ticks(view.y0, view.y1, 5)) {
			ctx.beginPath(), ctx.moveTo(pad.left, Math.round(py(t)) + 0.5), ctx.lineTo(pad.left + w, Math.round(py(t)) + 0.5), ctx.stroke();
			ctx.fillText(String(+t.toPrecision(6)), pad.left - 7, py(t) + 4);
		}
		ctx.textAlign = "center";
		ctx.fillText(labels.x, pad.left + w / 2, H - 4);
		ctx.save(), ctx.translate(11, pad.top + h / 2), ctx.rotate(-Math.PI / 2), ctx.fillText(labels.y, 0, 0), ctx.restore();
	}

	let frame = 0;
	const redraw = () => (cancelAnimationFrame(frame), (frame = requestAnimationFrame(draw)));
	data.addEventListener("wheel", (e) => {
		e.preventDefault();
		const r = data.getBoundingClientRect();
		const x = view.x0 + ((e.clientX - r.left) / r.width) * (view.x1 - view.x0);
		const y = view.y1 - ((e.clientY - r.top) / r.height) * (view.y1 - view.y0);
		const k = Math.exp(e.deltaY * 0.0015);
		view = { x0: x + (view.x0 - x) * k, x1: x + (view.x1 - x) * k, y0: y + (view.y0 - y) * k, y1: y + (view.y1 - y) * k };
		redraw();
	}, { passive: false });
	data.addEventListener("pointerdown", (e) => {
		data.setPointerCapture(e.pointerId);
		const start = { x: e.clientX, y: e.clientY, view };
		const r = data.getBoundingClientRect();
		const move = (ev: PointerEvent) => {
			const dx = ((ev.clientX - start.x) / r.width) * (start.view.x1 - start.view.x0);
			const dy = ((ev.clientY - start.y) / r.height) * (start.view.y1 - start.view.y0);
			view = { x0: start.view.x0 - dx, x1: start.view.x1 - dx, y0: start.view.y0 + dy, y1: start.view.y1 + dy };
			redraw();
		};
		data.addEventListener("pointermove", move);
		data.addEventListener("pointerup", () => data.removeEventListener("pointermove", move), { once: true });
	});
	data.addEventListener("dblclick", () => ((view = home), redraw()));
	const observer = new ResizeObserver(redraw);
	observer.observe(host);
	load(options);
	redraw();
	return {
		backend: renderer.backend,
		update: (next) => (load(next), redraw()),
		destroy: () => (observer.disconnect(), renderer.destroy(), data.remove(), axes.remove()),
	};
}
