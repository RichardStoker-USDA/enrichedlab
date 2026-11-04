// web_search for standalone use: one search provider the person configures. Signed-in sites can grant their own
// search tool instead; both can exist. Providers:
//
//   "search": { "provider": "brave",   "keyFile": "~/.secrets/brave_key" }
//   "search": { "provider": "tavily",  "keyFile": "~/.secrets/tavily_key" }
//   "search": { "provider": "searxng", "url": "https://search.example.org" }

import { readSecret } from "../util.ts";
import { num, str, type Tool, ToolError } from "./types.ts";

export interface SearchConfig {
	provider: "brave" | "tavily" | "searxng";
	keyFile?: string;
	keyEnv?: string;
	url?: string;
}

interface Hit {
	title: string;
	url: string;
	snippet: string;
}

const ENDPOINT: Record<SearchConfig["provider"], string> = {
	brave: "https://api.search.brave.com/res/v1/web/search",
	tavily: "https://api.tavily.com/search",
	searxng: "",
};

async function search(config: SearchConfig, query: string, count: number, signal: AbortSignal): Promise<Hit[]> {
	const key = config.keyFile || config.keyEnv ? readSecret({ keyFile: config.keyFile, keyEnv: config.keyEnv }) : undefined;
	const timeout = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	if (config.provider === "brave") {
		const url = `${ENDPOINT.brave}?${new URLSearchParams({ q: query, count: String(count) })}`;
		const response = await fetch(url, { headers: { accept: "application/json", "x-subscription-token": key ?? "" }, signal: timeout });
		if (!response.ok) throw new ToolError(`Brave search answered ${response.status}.`);
		const body = (await response.json()) as { web?: { results?: { title: string; url: string; description?: string }[] } };
		return (body.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description ?? "" }));
	}
	if (config.provider === "tavily") {
		const response = await fetch(ENDPOINT.tavily, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key ?? ""}` },
			body: JSON.stringify({ query, max_results: count }),
			signal: timeout,
		});
		if (!response.ok) throw new ToolError(`Tavily answered ${response.status}.`);
		const body = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
		return (body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
	}
	if (!config.url) throw new ToolError("SearXNG needs search.url in config.json.");
	const response = await fetch(`${config.url.replace(/\/+$/, "")}/search?${new URLSearchParams({ q: query, format: "json" })}`, { signal: timeout });
	if (!response.ok) throw new ToolError(`SearXNG answered ${response.status}.`);
	const body = (await response.json()) as { results?: { title: string; url: string; content?: string }[] };
	return (body.results ?? []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

export function searchTool(config: SearchConfig): Tool {
	const host = config.provider === "searxng" ? new URL(config.url ?? "https://searxng.invalid").host : new URL(ENDPOINT[config.provider]).host;
	return {
		name: "web_search",
		kind: "net",
		description: "Search the web. Returns titles, addresses and snippets; read a page with fetch.",
		parameters: {
			type: "object",
			properties: { query: { type: "string" }, count: { type: "integer", description: "Results, 1 to 20 (default 8)." } },
			required: ["query"],
			additionalProperties: false,
		},
		host: () => host,
		view: (a) => ({ verb: "search", target: String(a.query ?? "") }),
		async run(args, ctx) {
			const hits = await search(config, str(args, "query"), Math.min(20, Math.max(1, num(args, "count") ?? 8)), ctx.signal);
			const content = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
			return { ok: true, content: content || "No results.", view: { result: `${hits.length} results` } };
		},
	};
}
