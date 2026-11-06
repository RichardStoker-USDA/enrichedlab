// fetch, show, recall and plan: the web, the canvas, stored outputs and the visible plan.

import { VERSION } from "../util.ts";
import type { CanvasSummary } from "@enrichedlab/protocol";
import { num, str, type Tool, ToolError } from "./types.ts";

const FETCH_MAX_BYTES = 3 * 1024 * 1024;

/** Readable text from HTML: drop scripts, styles and chrome, keep headings, links and list structure. */
export function htmlToText(html: string): string {
	let text = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, "")
		.replace(/<(nav|footer|header|aside)[\s\S]*?<\/\1>/gi, "");
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
	text = text
		.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
		.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => (t.trim() ? `[${t.trim()}](${href})` : ""))
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<(br|hr)\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|section|article|tr|table|ul|ol|pre|blockquote)>/gi, "\n\n")
		.replace(/<(td|th)[^>]*>/gi, " | ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return title ? `# ${title}\n\n${text}` : text;
}

export const fetchTool: Tool = {
	name: "fetch",
	kind: "net",
	description: "Fetch a web page or file over HTTPS and return it as readable text (HTML is converted). For APIs, returns the raw body.",
	parameters: {
		type: "object",
		properties: { url: { type: "string" }, raw: { type: "boolean", description: "Return HTML unconverted." } },
		required: ["url"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "fetch", target: String(a.url ?? "") }),
	async run(args, ctx) {
		const url = new URL(str(args, "url"));
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new ToolError("Only http and https addresses can be fetched.");
		const response = await fetch(url, {
			headers: { "user-agent": `EnrichedLab/${VERSION} (+agent harness)`, accept: "text/html,application/json,text/plain,*/*;q=0.5" },
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
			redirect: "manual",
		});
		const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
		if (location) {
			const next = new URL(location, url);
			// The person agreed to this host, not to wherever it points; another host is fetched by a new call.
			return { ok: false, content: `${url} redirects to ${next}. Fetch that address to follow it.`, view: { result: `${response.status} → ${next.host}` } };
		}
		const type = response.headers.get("content-type") ?? "";
		// Read only up to the limit, so a huge response can't fill the engine's memory.
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body?.getReader();
		while (reader && size < FETCH_MAX_BYTES) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			size += value.length;
		}
		await reader?.cancel().catch(() => undefined);
		const buffer = Buffer.concat(chunks).subarray(0, FETCH_MAX_BYTES);
		if (/image\/|application\/(pdf|zip|octet-stream)/.test(type)) {
			return { ok: response.ok, content: `${url} returned ${type} (${buffer.length} bytes); not text.`, view: { result: `${response.status} ${type}` } };
		}
		let body = buffer.toString("utf8");
		if (/html/.test(type) && args.raw !== true) body = htmlToText(body);
		return { ok: response.ok, content: `${response.status} ${url}\n\n${body}`, view: { result: `${response.status}, ${(buffer.length / 1024).toFixed(0)} KB` } };
	},
};

const TABLE_FILE = /\.(csv|tsv|tab|json|jsonl|ndjson|parquet)$/i;
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
const IMAGE_MAX = 12 * 1024 * 1024;

export const showTool: Tool = {
	name: "show",
	kind: "local",
	description: [
		"Show something to the person in a pane beside the conversation. Pass the same id to update a view in place.",
		"- A data file (path to .csv, .tsv, .json, .jsonl, .parquet): an interactive table they can sort and filter, or with plot {x, y, color?, type?} a GPU-drawn scatter or line plot that handles millions of points.",
		"- A figure or widget a script saved (path to .png, .svg, .jpg, or a self-contained .html such as an htmlwidget, plotly or DT table): shown as saved. For R, save with ggsave() or htmlwidgets::saveWidget(selfcontained = TRUE).",
		"- A running app (url, e.g. a Shiny or Streamlit app or a dev server started on this computer): opened live in the browser pane.",
		"- Content you write (kind html, markdown or svg): HTML may use JavaScript, canvas and WebGPU.",
		"Paths are where the session works (this computer or a lab sandbox).",
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			title: { type: "string" },
			path: { type: "string", description: "A file to show: data, a figure or a self-contained HTML page." },
			plot: {
				type: "object",
				description: "With a data path: draw a plot instead of a table.",
				properties: { x: { type: "string" }, y: { type: "string" }, color: { type: "string" }, type: { type: "string", enum: ["scatter", "line"] } },
				required: ["x", "y"],
				additionalProperties: false,
			},
			url: { type: "string", description: "A running app to open, e.g. http://127.0.0.1:8050" },
			kind: { type: "string", enum: ["html", "markdown", "svg"], description: "With content." },
			content: { type: "string", description: "A document you write. HTML may be a fragment or a full page." },
			id: { type: "string", description: "An id from an earlier show call, to update that view." },
		},
		required: ["title"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "show", target: String(a.title ?? "") }),
	ask: (a, { workspace }) => (typeof a.path === "string" && a.path && !workspace.inside(a.path) ? `It shows ${workspace.display(a.path)}, outside the project folder.` : undefined),
	async run(args, ctx) {
		const base = { sessionId: ctx.sessionId, id: str(args, "id", false) || undefined, title: str(args, "title"), sealed: ctx.sealed };
		const path = str(args, "path", false);
		const url = str(args, "url", false);
		let canvas: CanvasSummary;
		if (url) {
			if (ctx.sealed) throw new ToolError("This lab keeps its data inside: views here can't open addresses. Show a saved figure or file instead.");
			const parsed = URL.canParse(url) ? new URL(url) : undefined;
			if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new ToolError("url must be an http or https address.");
			canvas = ctx.canvas.publish({ ...base, kind: "page", content: "", href: parsed.href });
		} else if (path) {
			const info = await ctx.workspace.stat(path);
			if (info?.type !== "file") throw new ToolError(`${ctx.workspace.display(path)} isn't a file.`);
			const ext = path.split(".").pop()?.toLowerCase() ?? "";
			const source = { path: ctx.workspace.resolve(path), place: ctx.place };
			if (TABLE_FILE.test(path)) {
				const plot = args.plot as { x: string; y: string; color?: string; type?: "scatter" | "line" } | undefined;
				canvas = ctx.canvas.publish({ ...base, kind: plot ? "plot" : "table", content: "", source, plot });
			} else if (IMAGE_TYPES[ext]) {
				if (info.size > IMAGE_MAX) throw new ToolError("The image is over 12 MB; save a smaller one.");
				const data = await ctx.workspace.read(path);
				canvas = ctx.canvas.publish({ ...base, kind: "image", content: `data:${IMAGE_TYPES[ext]};base64,${data.toString("base64")}` });
			} else if (ext === "html" || ext === "htm") {
				const data = await ctx.workspace.read(path);
				canvas = ctx.canvas.publish({ ...base, kind: "html", content: data.toString("utf8") });
			} else {
				throw new ToolError("show takes data (.csv .tsv .json .jsonl .parquet), images (.png .jpg .svg .gif .webp) and .html files.");
			}
		} else {
			const kind = str(args, "kind", false) as "html" | "markdown" | "svg";
			if (!["html", "markdown", "svg"].includes(kind)) throw new ToolError("Pass path, url, or kind (html, markdown or svg) with content.");
			canvas = ctx.canvas.publish({ ...base, kind, content: str(args, "content") });
		}
		const where = canvas.kind === "table" || canvas.kind === "plot" ? `as an interactive ${canvas.kind}` : canvas.kind === "page" ? `live at ${canvas.href}` : `at ${canvas.url}`;
		return {
			ok: true,
			content: `Showing "${canvas.title}" ${where} (id ${canvas.id}, version ${canvas.version}).`,
			view: { result: canvas.version > 1 ? `updated, v${canvas.version}` : `${canvas.kind}`, canvas: canvas.id },
		};
	},
};

export const recallTool: Tool = {
	name: "recall",
	kind: "local",
	description: "Read a stored output by its handle (long outputs and elided earlier outputs carry one). Pages by line.",
	parameters: {
		type: "object",
		properties: { handle: { type: "string" }, offset: { type: "integer", description: "First line (1-based)." }, limit: { type: "integer" } },
		required: ["handle"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "recall", target: String(a.handle ?? "") }),
	async run(args, ctx) {
		const handle = str(args, "handle");
		const text = ctx.log.readOutput(handle);
		if (text === undefined) throw new ToolError(`No stored output has handle "${handle}".`);
		const lines = text.split("\n");
		const offset = Math.max(1, Math.floor(num(args, "offset") ?? 1));
		const limit = Math.max(1, Math.min(1_500, Math.floor(num(args, "limit") ?? 600)));
		const slice = lines.slice(offset - 1, offset - 1 + limit).join("\n");
		const end = Math.min(lines.length, offset - 1 + limit);
		const more = end < lines.length ? `\n[Lines ${offset}-${end} of ${lines.length}. Continue with offset ${end + 1}.]` : "";
		return { ok: true, content: slice + more, view: { result: `lines ${offset}-${end} of ${lines.length}` } };
	},
};

export const planTool: Tool = {
	name: "plan",
	kind: "local",
	description:
		"Keep a short visible plan for multi-step work. Send the whole list each time; mark each step pending, active or done. One step active at a time.",
	parameters: {
		type: "object",
		properties: {
			steps: {
				type: "array",
				items: {
					type: "object",
					properties: { text: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done"] } },
					required: ["text", "status"],
					additionalProperties: false,
				},
			},
		},
		required: ["steps"],
		additionalProperties: false,
	},
	view: () => ({ verb: "plan", target: "" }),
	async run(args) {
		const steps = args.steps;
		if (!Array.isArray(steps)) throw new ToolError(`"steps" must be a list.`);
		const marks: Record<string, string> = { done: "[x]", active: "[>]", pending: "[ ]" };
		const lines = steps.map((s: Record<string, unknown>) => `${marks[String(s.status)] ?? "[ ]"} ${String(s.text ?? "")}`);
		const done = steps.filter((s: Record<string, unknown>) => s.status === "done").length;
		return { ok: true, content: `Plan updated.\n${lines.join("\n")}`, view: { result: `${done} of ${steps.length} done`, detail: lines.join("\n") } };
	},
};
