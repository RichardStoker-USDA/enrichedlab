// Canvases: what `show` publishes. Each is a document the engine serves at /canvas/<id> in a sandboxed origin, so
// model-written HTML can run scripts (charts, WebGPU) but can't reach the engine's API or the person's cookies.
// Viewers reload on a new version through a small event stream keyed by an unguessable per-canvas key.

import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { CanvasSummary } from "@enrichedlab/protocol";
import { marked } from "marked";
import type { CanvasInput, CanvasPublisher } from "./tools/types.ts";
import { newId, now, readJson, writeJson } from "./util.ts";

interface StoredCanvas extends CanvasSummary {
	content: string;
	key: string;
	sealed?: boolean;
}

const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// Pages follow the window's light or dark mode. Figures (an outer <svg>, an <img>) keep the colors they were drawn
// with: in dark mode they sit on white paper rather than being recolored, so black axis text stays readable.
const BASE_STYLE = `
:root{color-scheme:light dark;--fg:#0b1a2e;--muted:#5a6779;--rule:#d6dce4;--bg:#ffffff;--accent:#022851}
@media (prefers-color-scheme:dark){:root{--fg:#f2f2f2;--muted:#a3a3a3;--rule:#333333;--bg:#000000;--accent:#ffbf00}}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;padding:24px;max-width:960px}
h1,h2,h3{line-height:1.25;letter-spacing:-0.01em}
a{color:var(--accent)}
table{border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--rule);padding:6px 12px;text-align:left}
code,pre{font:12.5px/1.5 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
pre{background:color-mix(in srgb,var(--fg) 5%,transparent);padding:12px;border-radius:8px;overflow:auto}
img,svg{max-width:100%;height:auto}
@media (prefers-color-scheme:dark){svg:not(svg svg):not(button svg):not(a svg),img{background:#fff;color:#0b1a2e;border-radius:6px}}`;

export class CanvasStore implements CanvasPublisher {
	private canvases = new Map<string, StoredCanvas>();
	private watchers = new Map<string, Set<(version: number) => void>>();

	constructor(
		private dir: string,
		private origin: () => string,
		private onUpdate: (summary: CanvasSummary) => void,
	) {
		try {
			for (const file of readdirSync(dir)) {
				const stored = readJson<StoredCanvas | undefined>(join(dir, file), undefined);
				if (stored?.id) this.canvases.set(stored.id, stored);
			}
		} catch {
			// No canvases yet.
		}
	}

	private summary(c: StoredCanvas): CanvasSummary {
		const { content: _content, key: _key, sealed: _sealed, ...summary } = c;
		// The key in the address is what opens the page: loopback cookies cross ports, a capability in the URL doesn't.
		return { ...summary, url: c.kind === "page" && c.href ? c.href : `${this.origin()}/canvas/${c.id}?k=${c.key}` };
	}

	publish(input: CanvasInput): CanvasSummary {
		const existing = input.id ? this.canvases.get(input.id) : undefined;
		if (input.id && !existing) throw new Error(`No view has id ${input.id}; leave id out to make a new one.`);
		const stored: StoredCanvas = {
			id: existing?.id ?? newId("c"),
			sessionId: input.sessionId,
			title: input.title,
			kind: input.kind,
			url: "",
			updated: now(),
			version: (existing?.version ?? 0) + 1,
			content: input.content,
			key: existing?.key ?? randomBytes(18).toString("base64url"),
			source: input.source,
			plot: input.plot,
			href: input.href,
			sealed: input.sealed,
		};
		this.canvases.set(stored.id, stored);
		writeJson(join(this.dir, `${stored.id}.json`), stored, true);
		for (const watcher of this.watchers.get(stored.id) ?? []) watcher(stored.version);
		const summary = this.summary(stored);
		this.onUpdate(summary);
		return summary;
	}

	/** The stored view, for reading its data source. */
	get(id: string): CanvasSummary | undefined {
		const c = this.canvases.get(id);
		return c && this.summary(c);
	}

	list(sessionId?: string): CanvasSummary[] {
		return [...this.canvases.values()]
			.filter((c) => !sessionId || c.sessionId === sessionId)
			.sort((a, b) => b.updated.localeCompare(a.updated))
			.map((c) => this.summary(c));
	}

	/** Whether a canvas came from an isolated lab's session: it is served with no network access. */
	sealed(id: string): boolean {
		return this.canvases.get(id)?.sealed === true;
	}

	/** The page, when `key` is the canvas's own. */
	page(id: string, key?: string): string | undefined {
		if (key !== undefined && this.canvases.get(id)?.key !== key) return undefined;
		const c = this.canvases.get(id);
		if (!c) return undefined;
		const reload = `<script>(function(){var v=${c.version};try{var s=new EventSource(${JSON.stringify(`${this.origin()}/canvas/${c.id}/events?k=${c.key}`)});s.onmessage=function(e){if(Number(e.data)>v)location.reload()}}catch(e){}})()</script>`;
		const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(c.title)}</title>`;
		if (c.kind === "html") {
			const full = /<html[\s>]/i.test(c.content);
			if (full) return c.content.replace(/<\/body>/i, `${reload}</body>`) + (/<\/body>/i.test(c.content) ? "" : reload);
			return `<!doctype html><html><head>${head}<style>${BASE_STYLE}</style></head><body>${c.content}${reload}</body></html>`;
		}
		if (c.kind === "image") return `<!doctype html><html><head>${head}<style>${BASE_STYLE}body{max-width:none;display:grid;place-items:center;min-height:calc(100vh - 48px)}</style></head><body><img alt="${escape(c.title)}" src="${c.content}">${reload}</body></html>`;
		if (c.kind === "table" || c.kind === "plot" || c.kind === "page") {
			return `<!doctype html><html><head>${head}<style>${BASE_STYLE}</style></head><body><p>${escape(c.title)} opens in EnrichedLab's ${c.kind} pane.</p>${reload}</body></html>`;
		}
		const body = c.kind === "svg" ? c.content : (marked.parse(c.content, { async: false }) as string);
		return `<!doctype html><html><head>${head}<style>${BASE_STYLE}</style></head><body>${c.kind === "markdown" ? "" : `<h1>${escape(c.title)}</h1>`}${body}${reload}</body></html>`;
	}

	/** Watch a canvas for new versions; the key proves the watcher was handed the page. */
	watch(id: string, key: string, listener: (version: number) => void): (() => void) | undefined {
		const c = this.canvases.get(id);
		if (!c || c.key !== key) return undefined;
		let set = this.watchers.get(id);
		if (!set) this.watchers.set(id, (set = new Set()));
		set.add(listener);
		return () => set!.delete(listener);
	}
}
