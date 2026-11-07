// The tool catalog: what every tool a session can use does, in a form an agent can search. Each tool gets a one-line
// summary, the domains it belongs to (files, data, plots, documents, the lab's desktop…) and its argument names. A
// session with more tools than fit comfortably in a request is offered its core tools plus `find_tools`; the agent
// searches by what it needs ("fill a PDF form", "plot a CSV") and the tools it finds join the next request.
//
// Search is lexical (BM25 over names, summaries, descriptions, domains and arguments), which needs no model and works
// offline. A ranking by meaning can join it later through the same `search` (an embedding model at a lab, or on this
// computer), fused by reciprocal rank.

import type { Tool, ToolKind } from "./tools/types.ts";
import { str } from "./tools/types.ts";

export interface CatalogEntry {
	name: string;
	/** The description's first sentence, at most 180 characters. */
	summary: string;
	description: string;
	/** Domains, from the tool's name and description (DOMAINS). */
	tags: string[];
	/** Its argument names, required ones first. */
	args: string[];
	kind: ToolKind;
	/** The lab it acts at. */
	site?: string;
}

/** Domains a scientist's request maps onto, with the words that place a tool in each. */
const DOMAINS: [string, RegExp][] = [
	["files", /\b(file|folder|director|path|read|write|edit|glob|ls)\b/i],
	["code", /\b(code|script|function|repository|git|diff|patch|test)\b/i],
	["shell", /\b(shell|command|terminal|bash|exec|run)\b/i],
	["web", /\b(web|search|url|http|fetch|internet|site)\b/i],
	["browser", /\bbrowser|page|click|form field|web form\b/i],
	["desktop", /\bdesktop|screenshot|window|mouse|keyboard|gui\b/i],
	["data", /\b(data|dataset|table|csv|tsv|parquet|sql|database|query|rows?|columns?)\b/i],
	["plots", /\b(plot|chart|figure|graph|visuali[sz]|ggplot|matplotlib)\b/i],
	["documents", /\b(document|docx|word|markdown|report|text)\b/i],
	["pdf", /\bpdf\b/i],
	["spreadsheets", /\b(spreadsheet|excel|xlsx|sheet)\b/i],
	["apps", /\b(app|shiny|streamlit|dashboard|widget)\b/i],
	["research", /\b(paper|literature|citation|library|knowledge|research|lineage|experiment)\b/i],
	["lab", /\blab\b/i],
	["sandbox", /\bsandbox|container\b/i],
	["agents", /\b(agent|subagent|delegate)\b/i],
	["memory", /\b(recall|remember|memory|earlier output)\b/i],
	["planning", /\bplan|steps?|todo\b/i],
];

/** Always offered: enough to read, change and run things in the project, plus the way to find the rest. */
export const CORE_TOOLS = new Set(["read", "write", "edit", "ls", "glob", "grep", "shell", "plan", "recall", "show", "skill", "find_tools"]);

/** Above this many tools a session is offered its core tools and what it has found. */
export const DEFER_ABOVE = 40;

export function entry(tool: Tool): CatalogEntry {
	const description = tool.description.trim();
	const first = /^[\s\S]*?[.!?](\s|$)/.exec(description)?.[0]?.trim() ?? description;
	const summary = first.length > 180 ? `${first.slice(0, 179)}…` : first;
	const text = `${tool.name.replace(/_/g, " ")} ${description}`;
	const tags = DOMAINS.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
	if (tool.site && !tags.includes("lab")) tags.push("lab");
	const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] };
	const required = schema.required ?? [];
	const args = [...required, ...Object.keys(schema.properties ?? {}).filter((a) => !required.includes(a))];
	return { name: tool.name, summary, description, tags, args, kind: tool.kind, site: tool.site };
}

const STOP = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "it", "its", "this", "that", "with", "by", "as", "at", "be", "from", "i", "me", "my", "we", "you", "need", "want", "can", "how", "do", "use"]);

function words(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[_/.-]/g, " ")
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1 && !STOP.has(w))
		.map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** BM25 over each entry's fields; the name and domains weigh more than the long description. */
export class Catalog {
	private docs: { entry: CatalogEntry; terms: Map<string, number>; length: number }[];
	private df = new Map<string, number>();
	private average: number;

	constructor(readonly entries: CatalogEntry[]) {
		this.docs = entries.map((e) => {
			const terms = new Map<string, number>();
			const add = (text: string, weight: number) => {
				for (const w of words(text)) terms.set(w, (terms.get(w) ?? 0) + weight);
			};
			add(e.name, 3);
			add(e.tags.join(" "), 2);
			add(e.summary, 2);
			add(e.description, 1);
			add(e.args.join(" "), 1);
			let length = 0;
			for (const n of terms.values()) length += n;
			for (const term of terms.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
			return { entry: e, terms, length };
		});
		this.average = this.docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, this.docs.length);
	}

	search(query: string, limit = 8): { entry: CatalogEntry; score: number }[] {
		const terms = [...new Set(words(query))];
		if (!terms.length) return [];
		const n = this.docs.length;
		const k1 = 1.2;
		const b = 0.75;
		return this.docs
			.map((doc) => {
				let score = 0;
				for (const term of terms) {
					const tf = doc.terms.get(term);
					if (!tf) continue;
					const df = this.df.get(term) ?? 0;
					const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
					score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.average)));
				}
				return { entry: doc.entry, score };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);
	}
}

/** The tools a request offers: all of them while few, else the core, what the agent found or used, and find_tools. */
export function offered(all: Tool[], loaded: ReadonlySet<string>): Tool[] {
	if (all.length <= DEFER_ABOVE) return all.filter((t) => t.name !== "find_tools");
	return all.filter((t) => CORE_TOOLS.has(t.name) || loaded.has(t.name));
}

/** Names a find_tools answer made available, from its text (each found tool is written as `name`). */
export function foundNames(content: string): string[] {
	return [...content.matchAll(/^- `([A-Za-z0-9_.-]+)`/gm)].map((m) => m[1]!);
}

/** Search the session's tools by what the agent needs; the ones found join its next request. */
export function findTools(all: () => Tool[]): Tool {
	return {
		name: "find_tools",
		kind: "local",
		description:
			"Find tools by what you need to do, such as \"fill a PDF form\", \"plot a CSV\", \"use the lab's desktop\", \"search papers\" or \"run R in the lab sandbox\". This session has more tools than are listed; the ones found are available from your next step. Search again with other words if none fit.",
		parameters: { type: "object", properties: { query: { type: "string", description: "What you need to do, in a few words" }, limit: { type: "number", description: "How many tools, at most 12 (default 6)" } }, required: ["query"], additionalProperties: false },
		view: (a) => ({ verb: "find tools", target: String(a.query ?? "") }),
		async run(args) {
			const query = str(args, "query");
			const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
			const tools = all().filter((t) => t.name !== "find_tools");
			const found = new Catalog(tools.map(entry)).search(query, limit);
			if (!found.length) {
				const domains = [...new Set(tools.flatMap((t) => entry(t).tags))].sort().join(", ");
				return { ok: true, content: `No tool matches "${query}". The tools here cover: ${domains}. Try other words.`, view: { result: "none" } };
			}
			const lines = found.map(({ entry: e }) => `- \`${e.name}\`${e.site ? ` (at ${e.site})` : ""}: ${e.summary}${e.args.length ? ` Arguments: ${e.args.join(", ")}.` : ""}`);
			return { ok: true, content: `Available from your next step:\n${lines.join("\n")}`, view: { result: `${found.length} found` } };
		},
	};
}
