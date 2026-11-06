// What a model listing says, turned into a ModelProfile: its context window from whichever field the server uses, and
// reasoning support guessed from the name until config.json says otherwise.

import { labFetch } from "./http.ts";
import type { ModelProfile } from "./types.ts";

export const DEFAULT_CONTEXT = 32_768;
export const DEFAULT_OUTPUT = 8_192;

export interface ListedModel {
	id?: string;
	owned_by?: string;
	max_model_len?: number;
	context_length?: number;
	max_context_length?: number;
	/** Anthropic's Models API: the context window and the output cap. */
	max_input_tokens?: number;
	max_tokens?: number;
	meta?: { n_ctx_train?: number; n_ctx?: number };
}

export function contextOf(entry: ListedModel): number {
	const value = entry.max_model_len ?? entry.max_input_tokens ?? entry.max_context_length ?? entry.context_length ?? entry.meta?.n_ctx ?? entry.meta?.n_ctx_train;
	return typeof value === "number" && value > 0 ? value : DEFAULT_CONTEXT;
}

/** Guess reasoning support from the name; config.json overrides it. Families that think by default get levels. */
export function guessReasoning(id: string): Pick<ModelProfile, "efforts" | "effortField" | "replayReasoning"> {
	const lower = id.toLowerCase();
	if (/qwen3|qwq|deepseek-r|deepseek-v3\.[1-9]|deepseek-v4|glm-4\.[5-9]|glm-5|kimi-k2|gpt-oss|nemotron/.test(lower)) {
		const template = /qwen3|glm|deepseek/.test(lower);
		return {
			efforts: template ? ["off", "low", "medium", "high"] : ["low", "medium", "high"],
			effortField: template ? "chat_template_kwargs" : "reasoning_effort",
			replayReasoning: true,
		};
	}
	return { efforts: [], effortField: "none", replayReasoning: false };
}

export function guessVision(id: string): boolean {
	return /vl|vision|llava|gemma-?[34]|qwen3\.[5-9]|pixtral|llama-?4/i.test(id);
}

/** GET <baseUrl>/models, as OpenAI-compatible servers answer it (`data`, or `models` from a few). */
export async function listModels(baseUrl: string, headers: Record<string, string>, timeoutMs: number, ca?: string): Promise<ListedModel[]> {
	const response = await labFetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
		headers: { accept: "application/json", ...headers },
		signal: AbortSignal.timeout(timeoutMs),
		ca,
	});
	if (!response.ok) throw new Error(`answered ${response.status}`);
	const body = (await response.json()) as { data?: ListedModel[] | null; models?: ListedModel[] | null };
	return (body.data ?? body.models ?? []).filter((m) => typeof m.id === "string");
}

export function plainProfile(provider: string, label: string, baseUrl: string, entry: ListedModel, source: ModelProfile["source"], extra: Partial<ModelProfile> = {}): ModelProfile {
	const id = entry.id!;
	return {
		ref: `${provider}/${id}`,
		provider,
		id,
		label: `${id} · ${label}`,
		source,
		api: "openai-chat",
		baseUrl,
		context: contextOf(entry),
		maxOutput: DEFAULT_OUTPUT,
		vision: guessVision(id),
		...guessReasoning(id),
		headers: async () => ({}),
		...extra,
	};
}
