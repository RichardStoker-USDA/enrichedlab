// Anthropic Messages through the official SDK, streamed. An assistant turn keeps its exact content blocks (thinking
// with signatures, text, tool calls, in order) so they replay unchanged within the conversation. The context layer
// stops replaying them before the latest elision or compaction point, and `drop_block` asks the API to drop a block
// it can't verify instead of refusing the request.

import Anthropic from "@anthropic-ai/sdk";
import type { Part } from "@enrichedlab/protocol";
import { labFetch } from "./http.ts";
import { type ModelAdapter, ModelHttpError, type ModelRequest, type Msg, type StreamEvent } from "./types.ts";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Param = Anthropic.Beta.BetaMessageParam;

/** What an assistant event keeps for replay. */
export interface AnthropicReplay {
	anthropic: Block[];
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** Models that take the server-side refusal fallback in its "default" form. */
const FALLBACK_DEFAULT = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

function userBlocks(parts: Part[]): Block[] {
	return parts.map((p) =>
		p.type === "text"
			? { type: "text", text: p.text }
			: { type: "image", source: { type: "base64", media_type: p.mime as "image/png", data: p.data } },
	);
}

function parseArgs(args: string): Record<string, unknown> {
	try {
		const value = JSON.parse(args || "{}");
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

export function toAnthropicMessages(messages: Msg[]): Param[] {
	const out: Param[] = [];
	const push = (role: "user" | "assistant", blocks: Block[]) => {
		const last = out[out.length - 1];
		if (last && last.role === role && Array.isArray(last.content)) (last.content as Block[]).push(...blocks);
		else out.push({ role, content: blocks });
	};
	for (const m of messages) {
		if (m.role === "user") push("user", userBlocks(m.content));
		else if (m.role === "assistant") {
			const replay = (m.reasoningData as AnthropicReplay | undefined)?.anthropic;
			if (replay?.length) {
				push("assistant", replay);
				continue;
			}
			const blocks: Block[] = [];
			if (m.text) blocks.push({ type: "text", text: m.text });
			for (const call of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: call.id, name: call.name, input: parseArgs(call.args) });
			if (blocks.length) push("assistant", blocks);
		} else {
			const content: Anthropic.Beta.BetaToolResultBlockParam["content"] = [{ type: "text", text: m.content || "(no output)" }];
			for (const image of m.images ?? []) {
				if (image.type === "image") content.push({ type: "image", source: { type: "base64", media_type: image.mime as "image/png", data: image.data } });
			}
			push("user", [{ type: "tool_result", tool_use_id: m.callId, content }]);
		}
	}
	return out;
}

function client(request: ModelRequest, headers: Record<string, string>): Anthropic {
	const { "x-api-key": apiKey, authorization, ...rest } = headers;
	return new Anthropic({
		apiKey: apiKey ?? null,
		authToken: authorization?.replace(/^Bearer\s+/i, "") ?? null,
		baseURL: request.model.baseUrl.replace(/\/v1\/?$/, ""),
		defaultHeaders: rest,
		maxRetries: 0,
		fetch: ((url: string, init?: RequestInit) => labFetch(url, { ...init, ca: request.model.ca })) as typeof fetch,
	});
}

export const anthropic: ModelAdapter = {
	async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
		const { model } = request;
		const headers = await model.headers();
		const effort = EFFORTS.includes(request.effort as Effort) ? (request.effort as Effort) : undefined;
		const betas: Anthropic.Beta.AnthropicBeta[] = ["thinking-binding-controls-2026-08-01"];
		const params: Anthropic.Beta.MessageCreateParamsStreaming = {
			model: model.id,
			max_tokens: Math.min(request.maxTokens ?? model.maxOutput, model.maxOutput),
			messages: toAnthropicMessages(request.messages),
			// Caching: one breakpoint on the system prompt, which never changes within a session, and the automatic
			// breakpoint that follows the end of the conversation as it grows. Without them the API caches nothing.
			cache_control: { type: "ephemeral" },
			thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
			stream: true,
		};
		const system = [request.system, model.instructions].filter(Boolean).join("\n\n");
		if (system) params.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
		if (effort) params.output_config = { effort };
		if (request.tools.length) {
			params.tools = request.tools.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
				eager_input_streaming: true,
			}));
			if (request.toolChoice === "none") params.tool_choice = { type: "none" };
		}
		if (FALLBACK_DEFAULT.test(model.id)) {
			betas.push("server-side-fallback-2026-07-01");
			params.fallbacks = "default";
		}
		params.betas = betas;

		let stream: AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent>;
		try {
			stream = client(request, headers).beta.messages.stream(params, { signal });
		} catch (error) {
			throw mapError(error);
		}

		// Blocks in order, for exact replay. Tool calls are numbered in the order they start.
		const blocks: (Block & { _json?: string })[] = [];
		const toolIndex = new Map<number, number>();
		let tools = 0;
		let stop: StreamEvent & { type: "done" } = { type: "done", stop: "end" };
		let input = 0;
		let cached = 0;
		try {
			for await (const event of stream) {
				if (event.type === "message_start") {
					const u = event.message.usage;
					input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
					cached = u.cache_read_input_tokens ?? 0;
				} else if (event.type === "content_block_start") {
					const b = event.content_block;
					if (b.type === "thinking") blocks[event.index] = { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" };
					else if (b.type === "redacted_thinking") blocks[event.index] = { type: "redacted_thinking", data: b.data };
					else if (b.type === "text") {
						blocks[event.index] = { type: "text", text: b.text ?? "" };
						if (b.text) yield { type: "text", delta: b.text };
					} else if (b.type === "tool_use") {
						blocks[event.index] = { type: "tool_use", id: b.id, name: b.name, input: {}, _json: "" };
						toolIndex.set(event.index, tools);
						yield { type: "tool_start", index: tools++, id: b.id, name: b.name };
					}
				} else if (event.type === "content_block_delta") {
					const block = blocks[event.index];
					const d = event.delta;
					if (d.type === "text_delta" && block?.type === "text") {
						block.text += d.text;
						yield { type: "text", delta: d.text };
					} else if (d.type === "thinking_delta" && block?.type === "thinking") {
						block.thinking += d.thinking;
						yield { type: "reasoning", delta: d.thinking };
					} else if (d.type === "signature_delta" && block?.type === "thinking") {
						block.signature = d.signature;
					} else if (d.type === "input_json_delta" && block?.type === "tool_use") {
						block._json = (block._json ?? "") + d.partial_json;
						yield { type: "tool_args", index: toolIndex.get(event.index)!, delta: d.partial_json };
					}
				} else if (event.type === "message_delta") {
					const reason = event.delta.stop_reason;
					if (reason === "tool_use") stop = { type: "done", stop: "tool_use" };
					else if (reason === "max_tokens") stop = { type: "done", stop: "length" };
					else if (reason === "refusal") stop = { type: "done", stop: "error", error: "The model declined this request." };
					else stop = { type: "done", stop: "end" };
					const out = event.usage?.output_tokens ?? 0;
					yield { type: "usage", usage: { input, output: out, cached } };
				}
			}
		} catch (error) {
			if (signal.aborted) throw error;
			throw mapError(error);
		}
		const replay: Block[] = blocks.filter(Boolean).map((b) => {
			if (b.type !== "tool_use") return b;
			const { _json, ...rest } = b;
			return { ...rest, input: parseArgs(_json ?? "") };
		});
		yield { type: "reasoning_data", data: { anthropic: replay } satisfies AnthropicReplay };
		yield stop;
	},
};

function mapError(error: unknown): Error {
	if (error instanceof Anthropic.APIError) {
		const status = error.status ?? 0;
		const message = `Anthropic answered ${status || "with an error"}: ${error.message}`.slice(0, 400);
		const retryable = status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
		const overflow = status === 400 && /prompt is too long|context/i.test(error.message);
		return new ModelHttpError(status, message, retryable, undefined, overflow);
	}
	return error instanceof Error ? error : new Error(String(error));
}
