// OpenAI Responses API, streamed with `store: false`. Nothing is kept on OpenAI's side, so each request carries the
// whole conversation, and an assistant turn keeps its exact output items (encrypted reasoning, text, calls) to replay
// within the conversation. Used for ChatGPT plan sign-in, which takes only this API, and ready for API keys too.

import type { Part } from "@enrichedlab/protocol";
import { labFetch, sseData } from "./http.ts";
import { type ModelAdapter, ModelHttpError, type ModelRequest, type Msg, type StreamEvent } from "./types.ts";

/** What an assistant event keeps for replay: the response's output items, ids removed. */
export interface ResponsesReplay {
	responses: Record<string, unknown>[];
}

/** The namespace that holds EnrichedLab's tools when a route wants tools grouped (ChatGPT plan use does). */
export const TOOL_NAMESPACE = "enrichedlab";

/** Error codes that mean "stop and tell the person", never "try again now". */
const FINAL_CODES = /^(subscription_sharing_(usage_limit_exceeded|user_not_eligible|unsupported_capability|route_not_supported|invalid_user)|chatpass_v2_.*|invalid_request_error)$/;

export const USAGE_URL = "https://chatgpt.com/settings/usage";

/** A sentence for an error code, with what the person can do. */
export function explain(code: string | undefined, message: string): string {
	switch (code) {
		case "subscription_sharing_usage_limit_exceeded":
			return `Your ChatGPT plan's usage limit for EnrichedLab is reached. Review it in ChatGPT settings: ${USAGE_URL}`;
		case "subscription_sharing_user_not_eligible":
			return "This ChatGPT account or workspace can't use its plan in other apps.";
		case "subscription_sharing_usage_unavailable":
		case "subscription_sharing_user_unavailable":
			return "ChatGPT couldn't check your plan's usage just now. Try again in a minute.";
		case "subscription_sharing_invalid_user":
			return "ChatGPT didn't accept this sign-in. Sign in again under Model services.";
		default:
			return message;
	}
}

function userContent(parts: Part[], vision: boolean): unknown[] {
	return parts.map((p) =>
		p.type === "text"
			? { type: "input_text", text: p.text }
			: vision
				? { type: "input_image", image_url: `data:${p.mime};base64,${p.data}` }
				: { type: "input_text", text: "[image omitted: this model has no vision]" },
	);
}

/** Output items as the next request takes them: no ids (nothing is stored to point at) and no status. */
export function replayable(item: Record<string, unknown>): Record<string, unknown> | undefined {
	const { id: _id, status: _status, ...rest } = item;
	if (rest.type === "reasoning" || rest.type === "message" || rest.type === "function_call") return rest;
	return undefined;
}

export function toInput(request: ModelRequest, namespace?: string): unknown[] {
	const { model } = request;
	const out: unknown[] = [];
	// A batch of results must follow its calls; images from the batch follow it as one user message.
	let images: Part[] = [];
	const flush = () => {
		if (images.length && model.vision) out.push({ type: "message", role: "user", content: userContent(images, true) });
		images = [];
	};
	for (const m of request.messages as Msg[]) {
		if (m.role !== "tool") flush();
		if (m.role === "user") out.push({ type: "message", role: "user", content: userContent(m.content, model.vision) });
		else if (m.role === "assistant") {
			const replay = (m.reasoningData as ResponsesReplay | undefined)?.responses;
			if (replay?.length) {
				out.push(...replay);
				continue;
			}
			if (m.text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
			for (const call of m.toolCalls ?? []) {
				out.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.args || "{}", ...(namespace ? { namespace } : {}) });
			}
		} else {
			out.push({ type: "function_call_output", call_id: m.callId, output: m.content });
			if (m.images?.length) images.push({ type: "text", text: `Image output of ${m.name}:` }, ...m.images);
		}
	}
	flush();
	return out;
}

export function responsesBody(request: ModelRequest, namespace?: string): Record<string, unknown> {
	const { model } = request;
	const instructions = [request.system, model.instructions].filter(Boolean).join("\n\n");
	const body: Record<string, unknown> = { model: model.id, input: toInput(request, namespace), store: false, stream: true };
	if (instructions) body.instructions = instructions;
	if (request.tools.length) {
		const tools = request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false }));
		body.tools = namespace ? [{ type: "namespace", name: namespace, description: "EnrichedLab's tools for files, commands, the browser, views and apps.", tools }] : tools;
		body.tool_choice = request.toolChoice ?? "auto";
	}
	if (model.efforts.length) {
		const effort = request.effort ?? model.defaultEffort;
		body.reasoning = { ...(effort ? { effort: effort === "off" ? "none" : effort } : {}), summary: "auto" };
		body.include = ["reasoning.encrypted_content"];
	}
	return body;
}

async function failure(response: Response, who: string): Promise<ModelHttpError> {
	const text = await response.text().catch(() => "");
	let code: string | undefined;
	let message = text;
	try {
		const parsed = JSON.parse(text) as { error?: { code?: string; message?: string; type?: string }; detail?: string };
		code = parsed.error?.code ?? parsed.error?.type;
		message = parsed.error?.message ?? parsed.detail ?? text;
	} catch {
		// Not JSON: keep the text.
	}
	message = explain(code, message.replace(/\s+/g, " ").trim().slice(0, 400));
	const status = response.status;
	const retryable = !(code && FINAL_CODES.test(code)) && (status === 408 || status === 409 || status === 429 || status >= 500);
	const retryAfter = Number(response.headers.get("retry-after"));
	const overflow = status === 400 && /context|too long|maximum.*tokens|exceeds/i.test(message);
	return new ModelHttpError(status, `${who} answered ${status}${message ? `: ${message}` : ""}`, retryable, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined, overflow);
}

interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	input_tokens_details?: { cached_tokens?: number };
	output_tokens_details?: { reasoning_tokens?: number };
}

export function responsesAdapter(namespace?: string): ModelAdapter {
	return {
		async *stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
			const { model } = request;
			const response = await labFetch(`${model.baseUrl.replace(/\/+$/, "")}/responses`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "text/event-stream", ...(await model.headers()) },
				body: JSON.stringify(responsesBody(request, namespace)),
				signal,
				ca: model.ca,
				redirect: "manual",
			});
			if (!response.ok || !response.body) throw await failure(response, model.provider);

			const calls = new Map<number, { index: number; args: boolean }>();
			const items: Record<string, unknown>[] = [];
			let summaryParts = 0;
			let finished: "end" | "length" | undefined;
			for await (const { data } of sseData(response.body, signal)) {
				let event: Record<string, unknown> & { type?: string };
				try {
					event = JSON.parse(data);
				} catch {
					continue;
				}
				const at = typeof event.output_index === "number" ? event.output_index : -1;
				switch (event.type) {
					case "response.output_text.delta":
						if (typeof event.delta === "string") yield { type: "text", delta: event.delta };
						break;
					case "response.reasoning_summary_part.added":
						if (summaryParts++ > 0) yield { type: "reasoning", delta: "\n\n" };
						break;
					case "response.reasoning_summary_text.delta":
					case "response.reasoning_text.delta":
						if (typeof event.delta === "string") yield { type: "reasoning", delta: event.delta };
						break;
					case "response.output_item.added": {
						const item = event.item as { type?: string; call_id?: string; name?: string } | undefined;
						if (item?.type === "function_call") {
							const index = calls.size;
							calls.set(at, { index, args: false });
							yield { type: "tool_start", index, id: item.call_id || `call_${index}_${Date.now().toString(36)}`, name: item.name ?? "" };
						}
						break;
					}
					case "response.function_call_arguments.delta": {
						const call = calls.get(at);
						if (call && typeof event.delta === "string") {
							call.args = true;
							yield { type: "tool_args", index: call.index, delta: event.delta };
						}
						break;
					}
					case "response.output_item.done": {
						const item = event.item as Record<string, unknown> | undefined;
						if (!item) break;
						const call = calls.get(at);
						// Some servers send a call's arguments only with the finished item.
						if (call && !call.args && typeof item.arguments === "string" && item.arguments) yield { type: "tool_args", index: call.index, delta: item.arguments };
						const kept = replayable(item);
						if (kept) items.push(kept);
						break;
					}
					case "response.completed":
					case "response.incomplete": {
						const r = event.response as { usage?: Usage; incomplete_details?: { reason?: string } } | undefined;
						const u = r?.usage;
						if (u) {
							yield {
								type: "usage",
								usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens, reasoning: u.output_tokens_details?.reasoning_tokens },
							};
						}
						if (event.type === "response.incomplete") {
							const reason = r?.incomplete_details?.reason;
							if (reason !== "max_output_tokens") {
								yield { type: "done", stop: "error", error: `The answer stopped early (${reason ?? "incomplete"}).` };
								return;
							}
							finished = "length";
						} else finished = "end";
						break;
					}
					case "response.failed":
					case "error": {
						const error = (event.type === "error" ? event : (event.response as { error?: unknown } | undefined)?.error) as { code?: string; message?: string } | undefined;
						yield { type: "done", stop: "error", error: explain(error?.code, error?.message ?? "The model stream failed.") };
						return;
					}
				}
			}
			// Only `response.completed` (or a length stop) is an answer; a stream cut off before it is not.
			if (!finished) throw new Error("The model's stream ended early, before the response completed.");
			if (items.length) yield { type: "reasoning_data", data: { responses: items } satisfies ResponsesReplay };
			yield { type: "done", stop: finished === "length" ? "length" : calls.size ? "tool_use" : "end" };
		},
	};
}
