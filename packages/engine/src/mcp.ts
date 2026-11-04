// MCP servers as tools: local ones the person configures (stdio or Streamable HTTP) and the ones a site grants.
// A server's tool becomes `<server>_<tool>`. Tools the server marks read-only run; others ask.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AppToolResult, FileRef, Part, StepView } from "@enrichedlab/protocol";
import type { McpView } from "./apps/host.ts";
import type { McpServerConfig } from "./config.ts";
import { labFetch } from "./models/http.ts";
import type { Tool, ToolKind } from "./tools/types.ts";
import { clip, errorText, expandHome, readSecret, redact, VERSION } from "./util.ts";

export interface McpConnection {
	name: string;
	tools: Tool[];
	error?: string;
	close(): Promise<void>;
}

interface RemoteOptions {
	url: string;
	headers: () => Promise<Record<string, string>>;
	ca?: string;
	/** `site` tools are named and gated as site tools. */
	origin: "site" | "local";
}

const safeName = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");

export function toolName(server: string, tool: string): string {
	return clip(`${safeName(server)}_${safeName(tool)}`, 64).replace(/…$/, "");
}

type McpContent = {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	uri?: string;
	name?: string;
	size?: number;
	_meta?: Record<string, unknown>;
	resource?: { uri?: string; text?: string };
};

/** A file returned by reference (MCP resource_link), with the checksum labs put in `_meta`. */
function fileRef(part: McpContent): FileRef | undefined {
	if (!part.uri) return undefined;
	const sha = part._meta?.["org.enrichedlab/sha256"] ?? part._meta?.sha256;
	const name = part.name || decodeURIComponent(part.uri.split(/[?#]/)[0]!.split("/").filter(Boolean).at(-1) ?? "file");
	return { uri: part.uri, name, mime: part.mimeType, bytes: typeof part.size === "number" ? part.size : undefined, sha256: typeof sha === "string" && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : undefined };
}

/** What a lab says about how a result was made, so a person can run it again (docs/labs.md). */
function receiptText(meta: unknown): string | undefined {
	const receipt = (meta as Record<string, unknown> | undefined)?.["org.enrichedlab/receipt"] as Record<string, unknown> | undefined;
	if (!receipt || typeof receipt !== "object") return undefined;
	const line = (label: string, value: unknown) => (value === undefined ? [] : [`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`]);
	return [
		"How this was made",
		...line("receipt", receipt.id),
		...line("inputs", receipt.inputs),
		...line("code version", receipt.code_version),
		...line("parameters", receipt.parameters),
		...line("seed", receipt.seed),
		...line("image", receipt.image_digest),
		...line("outputs", receipt.outputs),
	].join("\n");
}

type Listed = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** MCP Apps metadata on a tool: its view's ui:// address and who may call it. */
function uiMeta(t: Listed): { uri?: string; visibility: string[] } {
	const meta = (t._meta ?? {}) as { ui?: { resourceUri?: string; visibility?: string[] }; "ui/resourceUri"?: string };
	const uri = meta.ui?.resourceUri ?? meta["ui/resourceUri"];
	return { uri: typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined, visibility: Array.isArray(meta.ui?.visibility) ? meta.ui.visibility : ["model", "app"] };
}

/** Read a server's ui:// view once per connection. */
function viewReader(client: Client) {
	const cache = new Map<string, Promise<{ html: string; csp?: McpView["csp"] }>>();
	return (uri: string) => {
		let hit = cache.get(uri);
		if (!hit) {
			hit = client.readResource({ uri }).then((r) => {
				const c = r.contents[0] as { text?: string; blob?: string; _meta?: { ui?: { csp?: McpView["csp"] } } } | undefined;
				const html = c?.text ?? (c?.blob ? Buffer.from(c.blob, "base64").toString("utf8") : "");
				if (!html) throw new Error(`${uri} is empty.`);
				return { html, csp: c?._meta?.ui?.csp };
			});
			hit.catch(() => cache.delete(uri));
			cache.set(uri, hit);
		}
		return hit;
	};
}

/** MCP tools as the agent sees them (exported for tests). */
export function toTools(server: string, client: Client, listed: Listed[], origin: "site" | "local"): Tool[] {
	const readView = viewReader(client);
	// A view may call its own server's tools that are visible to apps, and only those.
	const callFromView = async (name: string, args: Record<string, unknown>): Promise<AppToolResult> => {
		const target = listed.find((t) => t.name === name);
		if (!target || !uiMeta(target).visibility.includes("app")) throw new Error(`${server} has no tool ${name} for its views.`);
		const result = await client.callTool({ name, arguments: args }, { timeout: 300_000 });
		return { content: (result.content ?? []) as AppToolResult["content"], structuredContent: result.structuredContent as Record<string, unknown> | undefined, isError: result.isError === true };
	};
	return listed.filter((t) => uiMeta(t).visibility.includes("model")).map((t) => {
		const ui = uiMeta(t);
		const readOnly = t.annotations?.readOnlyHint === true;
		const kind: ToolKind = readOnly ? "site-read" : "site-write";
		const name = toolName(server, t.name);
		// Labs mark model-extended tools that no person has checked yet (docs/labs.md).
		const unreviewed = (t._meta as Record<string, unknown> | undefined)?.["org.enrichedlab/tier"] === "unvalidated";
		return {
			name,
			kind,
			unreviewed,
			description: `${t.description ?? t.title ?? t.name}${origin === "site" ? ` (from ${server})` : ""}`,
			parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
			view: (args) => ({ verb: name, target: clip(Object.values(args).filter((v) => typeof v === "string").join(" ") || t.title || "", 200), ...(unreviewed ? { unreviewed } : {}) }),
			async run(args, ctx) {
				const result = await client.callTool({ name: t.name, arguments: args }, { signal: ctx.signal, timeout: 300_000 });
				const parts = (result.content ?? []) as McpContent[];
				const texts: string[] = [];
				const images: Part[] = [];
				const files: FileRef[] = [];
				for (const part of parts) {
					if (part.type === "text" && part.text) texts.push(part.text);
					else if (part.type === "image" && part.data) images.push({ type: "image", mime: part.mimeType ?? "image/png", data: part.data });
					else if (part.type === "resource" && part.resource?.text) texts.push(part.resource.text);
					else if (part.type === "resource_link") {
						const ref = fileRef(part);
						if (!ref) continue;
						files.push(ref);
						// The model gets the reference, never the rows: the person saves a copy when they want one.
						texts.push(`[file ${ref.name} at ${ref.uri}${ref.mime ? `, ${ref.mime}` : ""}${ref.bytes !== undefined ? `, ${ref.bytes} bytes` : ""}${ref.sha256 ? `, sha256 ${ref.sha256}` : ""}]`);
					} else if (part.type === "resource") texts.push(`[resource ${part.resource?.uri ?? ""}]`);
				}
				const receipt = receiptText(result._meta);
				if (!texts.length && result.structuredContent) texts.push(JSON.stringify(result.structuredContent, null, 2));
				const isError = result.isError === true;
				// MCP Apps: the tool has a view; show it with this call's input and result.
				if (ui.uri && ctx.apps && !isError) {
					try {
						const view = await readView(ui.uri);
						ctx.apps.publishView({
							server,
							uri: ui.uri,
							title: t.title ?? t.name,
							html: view.html,
							csp: view.csp,
							toolInput: args,
							toolResult: { content: parts as AppToolResult["content"], structuredContent: result.structuredContent as Record<string, unknown> | undefined, isError },
							call: callFromView,
						});
						texts.push("(Its view is open in the person's workbench.)");
					} catch (error) {
						texts.push(`(Its view couldn't be shown: ${errorText(error)})`);
					}
				}
				const view: Partial<StepView> = { result: isError ? "failed" : files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "done" };
				if (files.length) view.files = files;
				if (receipt) view.detail = receipt;
				return { ok: !isError, content: [...texts, ...(receipt ? [receipt] : [])].join("\n\n") || (isError ? "The tool failed." : "(no output)"), images: images.length ? images : undefined, view };
			},
		} satisfies Tool;
	});
}

async function connect(name: string, transport: StdioClientTransport | StreamableHTTPClientTransport, origin: "site" | "local"): Promise<McpConnection> {
	const client = new Client({ name: "enrichedlab", version: VERSION }, { capabilities: {} });
	await client.connect(transport);
	const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listTools(cursor ? { cursor } : undefined);
		tools.push(...page.tools);
		cursor = page.nextCursor;
	} while (cursor);
	return { name, tools: toTools(name, client, tools, origin), close: () => client.close() };
}

export async function connectRemote(name: string, options: RemoteOptions): Promise<McpConnection> {
	const transport = new StreamableHTTPClientTransport(new URL(options.url), {
		fetch: (async (url: string | URL, init?: RequestInit) =>
			labFetch(String(url), { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), ...(await options.headers()) }, ca: options.ca })) as typeof fetch,
	});
	return connect(name, transport, options.origin);
}

export async function connectConfigured(name: string, config: McpServerConfig): Promise<McpConnection> {
	if (config.url) {
		const bearer = config.bearerFile ? readSecret({ keyFile: config.bearerFile }) : undefined;
		return connectRemote(name, {
			url: config.url,
			headers: async () => ({ ...config.headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }),
			origin: "local",
		});
	}
	if (!config.command) throw new Error(`MCP server ${name} needs a command or a url.`);
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	for (const [key, value] of Object.entries(config.env ?? {})) env[key] = expandHome(value);
	const transport = new StdioClientTransport({ command: expandHome(config.command), args: (config.args ?? []).map(expandHome), env, stderr: "ignore" });
	return connect(name, transport, "local");
}

/** Connections to the person's configured servers, kept for the engine's life and reconnected on change. */
export class McpManager {
	private connections = new Map<string, McpConnection>();
	readonly errors = new Map<string, string>();
	private syncing: Promise<void> = Promise.resolve();

	/** Connect what's wanted and close what isn't. Calls run one after another, so a server never connects twice. */
	sync(servers: Record<string, McpServerConfig>): Promise<void> {
		this.syncing = this.syncing.then(() => this.syncNow(servers));
		return this.syncing;
	}

	private async syncNow(servers: Record<string, McpServerConfig>): Promise<void> {
		const wanted = Object.entries(servers).filter(([, c]) => c.enabled !== false);
		for (const [name, connection] of this.connections) {
			if (!wanted.some(([n]) => n === name)) {
				await connection.close().catch(() => undefined);
				this.connections.delete(name);
			}
		}
		await Promise.all(
			wanted
				.filter(([name]) => !this.connections.has(name))
				.map(async ([name, config]) => {
					try {
						this.connections.set(name, await connectConfigured(name, config));
						this.errors.delete(name);
					} catch (error) {
						this.errors.set(name, redact(errorText(error)));
					}
				}),
		);
	}

	tools(): Tool[] {
		return [...this.connections.values()].flatMap((c) => c.tools);
	}

	async close(): Promise<void> {
		await Promise.all([...this.connections.values()].map((c) => c.close().catch(() => undefined)));
		this.connections.clear();
	}
}
