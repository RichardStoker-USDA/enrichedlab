// Ollama through its own API. Its OpenAI endpoint can't set the context window, so every prompt there is cut to
// Ollama's 4,096-token default; /api/chat takes `options.num_ctx`. Also: the models it has, with their trained context
// and capabilities (/api/tags, /api/show), and downloads with progress (/api/pull). Since 0.40.0 Ollama runs models on
// MLX by default on Apple silicon wherever MLX supports the architecture.

import type { Part } from "@enrichedlab/protocol";
import { httpError, labFetch } from "./http.ts";
import type { ModelAdapter, ModelRequest, Msg, StreamEvent } from "./types.ts";

/** The first release that runs models on MLX by default on Apple silicon. */
export const OLLAMA_MLX_DEFAULT = "0.40.0";

export interface OllamaModel {
	name: string;
	/** Bytes on disk. */
	size: number;
	family?: string;
	/** The context the model was trained for, from its metadata; undefined when Ollama doesn't say. */
	trained?: number;
	/** completion, tools, thinking, vision, embedding, ... (empty from an Ollama too old to say). */
	capabilities: string[];
}

export interface PullProgress {
	status: string;
	total?: number;
	completed?: number;
}

/** The host root (`http://127.0.0.1:11434`) of a base URL that may end in /v1. */
export function ollamaRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function json<T>(url: string, init: RequestInit & { timeoutMs: number }): Promise<T> {
	const { timeoutMs, ...rest } = init;
	const response = await labFetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw await httpError(response, "Ollama");
	return (await response.json()) as T;
}

export async function ollamaVersion(baseUrl: string, timeoutMs = 600): Promise<string | undefined> {
	try {
		const body = await json<{ version?: string }>(`${ollamaRoot(baseUrl)}/api/version`, { timeoutMs });
		return typeof body.version === "string" ? body.version : undefined;
	} catch {
		return undefined;
	}
}

/** True when `version` is at least `floor` (both dotted numbers; a prerelease suffix is ignored). */
export function atLeast(version: string, floor: string): boolean {
	const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number(n) || 0);
	const [a, b] = [parts(version), parts(floor)];
	for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return true;
}

/** Every model Ollama has, each with what /api/show says about it. */
export async function ollamaModels(baseUrl: string, timeoutMs = 2000): Promise<OllamaModel[]> {
	const root = ollamaRoot(baseUrl);
	const tags = await json<{ models?: { name: string; size?: number; details?: { family?: string } }[] }>(`${root}/api/tags`, { timeoutMs });
	return Promise.all(
		(tags.models ?? []).map(async (m) => {
			let show: { model_info?: Record<string, unknown>; capabilities?: string[] } = {};
			try {
				show = await json(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.name }), timeoutMs });
			} catch {
				// Listed without details: it still runs, with the defaults below.
			}
			const trained = Object.entries(show.model_info ?? {}).find(([key, value]) => key.endsWith(".context_length") && typeof value === "number")?.[1] as number | undefined;
			return { name: m.name, size: m.size ?? 0, family: m.details?.family, trained, capabilities: show.capabilities ?? [] };
		}),
	);
}

/** Read newline-delimited JSON objects from a response body. */
async function* ndjson<T>(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<T> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const abort = () => reader.cancel().catch(() => undefined);
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) yield JSON.parse(line) as T;
			}
		}
		if (buffer.trim()) yield JSON.parse(buffer) as T;
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}

/** Download a model, reporting progress; ends after "success" or throws Ollama's error. */
export async function* pullModel(baseUrl: string, name: string, signal: AbortSignal): AsyncGenerator<PullProgress> {
	const response = await labFetch(`${ollamaRoot(baseUrl)}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name, stream: true }), signal });
	if (!response.ok || !response.body) throw await httpError(response, "Ollama");
	for await (const line of ndjson<PullProgress & { error?: string }>(response.body, signal)) {
		if (line.error) throw new Error(/file does not exist|not found/i.test(line.error) ? `Ollama's library has no model named ${name}.` : `Ollama: ${line.error}`);
		yield { status: line.status, total: line.total, completed: line.completed };
		if (line.status === "success") return;
	}
	throw new Error(`Ollama stopped before ${name} finished downloading.`);
}

export async function removeModel(baseUrl: string, name: string): Promise<void> {
	const response = await labFetch(`${ollamaRoot(baseUrl)}/api/delete`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw await httpError(response, "Ollama");
}

// ── Chat ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function text(parts: Part[]): string {
	return parts.map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

function images(parts: Part[]): string[] {
	return parts.flatMap((p) => (p.type === "image" ? [p.data] : []));
}

function args(raw: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw || "{}") as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function ollamaMessages(request: ModelRequest): unknown[] {
	const { model } = request;
	const out: unknown[] = [];
	const system = [request.system, model.instructions].filter(Boolean).join("\n\n");
	if (system) out.push({ role: "system", content: system });
	// Reasoning after the last user message belongs to the current turn and goes back to the model.
	let turnStart = 0;
	for (let i = request.messages.length - 1; i >= 0; i--) {
		if (request.messages[i]!.role === "user") {
			turnStart = i;
			break;
		}
	}
	// Images a tool returned follow its batch of results as one user message, as with Chat Completions.
	let pending: Part[] = [];
	const flush = () => {
		if (pending.length && model.vision) out.push({ role: "user", content: text(pending), images: images(pending) });
		pending = [];
	};
	request.messages.forEach((m: Msg, index) => {
		if (m.role !== "tool") flush();
		if (m.role === "user") {
			const pictures = model.vision ? images(m.content) : [];
			const words = text(m.content) || (m.content.some((p) => p.type === "image") && !model.vision ? "[image omitted: this model has no vision]" : "");
			out.push({ role: "user", content: words, ...(pictures.length ? { images: pictures } : {}) });
		} else if (m.role === "assistant") {
			const message: Record<string, unknown> = { role: "assistant", content: m.text };
			if (m.toolCalls?.length) message.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: args(c.args) } }));
			if (model.replayReasoning && m.reasoning && index > turnStart) message.thinking = m.reasoning;
			out.push(message);
		} else {
			out.push({ role: "tool", content: m.content, tool_name: m.name });
			if (m.images?.length) pending.push({ type: "text", text: `Image output of ${m.name}:` }, ...m.images);
		}
	});
	flush();
	return out;
}

export function ollamaBody(request: ModelRequest, think?: boolean | string): Record<string, unknown> {
	const { model } = request;
	const options: Record<string, unknown> = { num_ctx: model.context, num_predict: Math.min(request.maxTokens ?? model.maxOutput, model.maxOutput) };
	if (model.temperature !== undefined) options.temperature = model.temperature;
	const body: Record<string, unknown> = { model: model.id, messages: ollamaMessages(request), stream: true, options };
	if (request.tools.length && request.toolChoice !== "none") body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
	if (think !== undefined) body.think = think;
	else if (request.effort && model.efforts.length) body.think = request.effort === "off" ? false : request.effort;
	return body;
}

interface ChatChunk {
	message?: { content?: string; thinking?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: unknown } }[] };
	done?: boolean;
	done_reason?: string;
	prompt_eval_count?: number;
	eval_count?: number;
	error?: string;
}

async function open(request: ModelRequest, signal: AbortSignal, think?: boolean | string): Promise<Response> {
	const { model } = request;
	return labFetch(`${ollamaRoot(model.baseUrl)}/api/chat`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(await model.headers()) },
		body: JSON.stringify(ollamaBody(request, think)),
		signal,
		ca: model.ca,
	});
}

export const ollamaChat: ModelAdapter = {
	async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
		let response = await open(request, signal);
		// A model that thinks but takes no levels refuses a level: ask again with thinking simply on.
		if (response.status === 400 && request.effort && request.effort !== "off") {
			const error = await httpError(response, "Ollama");
			if (!/think/i.test(error.message)) throw error;
			response = await open(request, signal, true);
		}
		if (!response.ok || !response.body) throw await httpError(response, "Ollama");
		let calls = 0;
		for await (const chunk of ndjson<ChatChunk>(response.body, signal)) {
			if (chunk.error) {
				yield { type: "done", stop: "error", error: chunk.error };
				return;
			}
			const m = chunk.message;
			if (m?.thinking) yield { type: "reasoning", delta: m.thinking };
			if (m?.content) yield { type: "text", delta: m.content };
			for (const call of m?.tool_calls ?? []) {
				const index = calls++;
				yield { type: "tool_start", index, id: call.id || `call_${index}_${Date.now().toString(36)}`, name: call.function?.name ?? "" };
				const value = call.function?.arguments;
				yield { type: "tool_args", index, delta: typeof value === "string" ? value : JSON.stringify(value ?? {}) };
			}
			if (chunk.done) {
				yield { type: "usage", usage: { input: chunk.prompt_eval_count ?? 0, output: chunk.eval_count ?? 0 } };
				yield { type: "done", stop: chunk.done_reason === "length" ? "length" : calls ? "tool_use" : "end" };
				return;
			}
		}
		throw new Error("The model's stream ended early, before Ollama said it was done.");
	},
};
