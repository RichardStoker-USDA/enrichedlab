// OpenAI Chat Completions with streaming. This one protocol reaches Gate, vLLM, SGLang, llama.cpp, oMLX, MLX, LM Studio,
// DeepSeek, OpenRouter and most hosted APIs. Reasoning arrives as `reasoning_content` or `reasoning` depending on the
// server; both are read. The reasoning level goes where the model's profile says.

import type { Part } from "@enrichedlab/protocol";
import { httpError, modelPost, sseData } from "./http.ts";
import type { ModelAdapter, ModelRequest, Msg, StreamEvent } from "./types.ts";

type Content = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

function content(parts: Part[], vision: boolean): Content {
	const images = parts.filter((p) => p.type === "image");
	if (!images.length || !vision) return parts.map((p) => (p.type === "text" ? p.text : "[image omitted: this model has no vision]")).join("\n");
	return parts.map((p) =>
		p.type === "text" ? { type: "text" as const, text: p.text } : { type: "image_url" as const, image_url: { url: `data:${p.mime};base64,${p.data}` } },
	);
}

/** Index of the last user message: reasoning after it belongs to the current turn. */
function currentTurnStart(messages: Msg[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
	return 0;
}

export function toChatMessages(request: ModelRequest): unknown[] {
	const { model } = request;
	const out: unknown[] = [];
	const system = [request.system, model.instructions].filter(Boolean).join("\n\n");
	if (system) out.push({ role: "system", content: system });
	const turnStart = currentTurnStart(request.messages);
	// Chat Completions tool messages carry text only, and a call's results must follow it without anything between,
	// so images from a batch of results wait and follow the whole batch as one user message.
	let images: Part[] = [];
	const flushImages = () => {
		if (images.length && model.vision) out.push({ role: "user", content: content(images, true) });
		images = [];
	};
	request.messages.forEach((m, index) => {
		if (m.role !== "tool") flushImages();
		if (m.role === "user") out.push({ role: "user", content: content(m.content, model.vision) });
		else if (m.role === "assistant") {
			const message: Record<string, unknown> = { role: "assistant", content: m.text || (m.toolCalls?.length ? null : "") };
			if (m.toolCalls?.length) {
				message.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
			}
			if (model.replayReasoning && m.reasoning && index > turnStart) message.reasoning_content = m.reasoning;
			out.push(message);
		} else {
			out.push({ role: "tool", tool_call_id: m.callId, content: m.content });
			if (m.images?.length) images.push({ type: "text", text: `Image output of ${m.name}:` }, ...m.images);
		}
	});
	flushImages();
	return out;
}

export function chatBody(request: ModelRequest): Record<string, unknown> {
	const { model } = request;
	const body: Record<string, unknown> = {
		model: model.id,
		messages: toChatMessages(request),
		stream: true,
		stream_options: { include_usage: true },
	};
	// OpenAI's own API takes max_completion_tokens (reasoning models refuse max_tokens); compatible servers take max_tokens.
	const limit = Math.min(request.maxTokens ?? model.maxOutput, model.maxOutput);
	if (/(^|\.)openai\.com$/.test(new URL(model.baseUrl).hostname)) body.max_completion_tokens = limit;
	else body.max_tokens = limit;
	if (model.temperature !== undefined) body.temperature = model.temperature;
	if (request.tools.length) {
		body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
		body.tool_choice = request.toolChoice ?? "auto";
	}
	const effort = request.effort;
	if (effort && model.efforts.length) {
		if (model.effortField === "chat_template_kwargs") {
			body.chat_template_kwargs =
				effort === "off" ? { enable_thinking: false } : { enable_thinking: true, preserve_thinking: true, reasoning_effort: effort };
		} else if (model.effortField === "reasoning_effort") {
			body.reasoning_effort = effort === "off" ? "none" : effort;
		}
	}
	return body;
}

interface ChunkChoice {
	delta?: {
		content?: string | null;
		reasoning_content?: string | null;
		reasoning?: string | null;
		tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
	};
	finish_reason?: string | null;
}

export const openaiChat: ModelAdapter = {
	async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
		const { model } = request;
		await model.prepare?.(signal);
		const response = await modelPost(model, `${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, JSON.stringify(chatBody(request)), signal, { "content-type": "application/json", accept: "text/event-stream" }, "manual");
		if (response.status >= 300 && response.status < 400) {
			throw await httpError(new Response("The service asked for a sign-in. Run el login.", { status: 401 }), model.provider);
		}
		if (!response.ok || !response.body) throw await httpError(response, model.provider);

		const started = new Set<number>();
		let finish: string | null | undefined;
		for await (const { data } of sseData(response.body, signal)) {
			let chunk: { choices?: ChunkChoice[]; usage?: Record<string, unknown>; error?: { message?: string } };
			try {
				chunk = JSON.parse(data);
			} catch {
				continue;
			}
			if (chunk.error) {
				yield { type: "done", stop: "error", error: chunk.error.message ?? "The model stream failed." };
				return;
			}
			const choice = chunk.choices?.[0];
			const delta = choice?.delta;
			if (delta) {
				const reasoning = delta.reasoning_content ?? delta.reasoning;
				if (reasoning) yield { type: "reasoning", delta: reasoning };
				if (delta.content) yield { type: "text", delta: delta.content };
				for (const call of delta.tool_calls ?? []) {
					const index = call.index ?? 0;
					if (!started.has(index)) {
						started.add(index);
						yield { type: "tool_start", index, id: call.id || `call_${index}_${Date.now().toString(36)}`, name: call.function?.name ?? "" };
					}
					if (call.function?.arguments) yield { type: "tool_args", index, delta: call.function.arguments };
				}
			}
			if (choice?.finish_reason) finish = choice.finish_reason;
			if (chunk.usage) {
				const u = chunk.usage as {
					prompt_tokens?: number;
					completion_tokens?: number;
					prompt_tokens_details?: { cached_tokens?: number };
					completion_tokens_details?: { reasoning_tokens?: number };
				};
				yield {
					type: "usage",
					usage: {
						input: u.prompt_tokens ?? 0,
						output: u.completion_tokens ?? 0,
						cached: u.prompt_tokens_details?.cached_tokens,
						reasoning: u.completion_tokens_details?.reasoning_tokens,
					},
				};
			}
		}
		// A stream that closes without a finish reason was cut off (proxy timeout, server restart): not an answer.
		if (!finish) throw new Error("The model's stream ended early, before a finish reason.");
		const stop = finish === "length" ? "length" : started.size || finish === "tool_calls" ? "tool_use" : "end";
		yield { type: "done", stop };
	},
};
