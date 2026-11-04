// Every model the person can use right now, from three places: local servers found on their usual ports, providers
// in config.json, and signed-in sites. A model reference is `<provider>/<model id>`.

import { readFileSync } from "node:fs";
import type { ModelInfo } from "@enrichedlab/protocol";
import type { LabConfig, ModelOverride, ProviderConfig } from "../config.ts";
import { errorText, expandHome, readSecret } from "../util.ts";
import { labFetch } from "./http.ts";
import { openaiChat } from "./openai_chat.ts";
import { anthropic } from "./anthropic.ts";
import { accessToken, planModels } from "./chatgpt.ts";
import { responsesAdapter, TOOL_NAMESPACE } from "./openai_responses.ts";
import { loadKey } from "./providers.ts";
import type { ModelAdapter, ModelProfile } from "./types.ts";

export const LOCAL_SERVERS: { name: string; label: string; baseUrl: string }[] = [
	{ name: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
	{ name: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
	{ name: "llamacpp", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080/v1" },
	{ name: "vllm", label: "vLLM", baseUrl: "http://127.0.0.1:8000/v1" },
];

const DEFAULT_CONTEXT = 32_768;
const DEFAULT_OUTPUT = 8_192;

/** Something that contributes models (a site). */
export interface ModelSource {
	name: string;
	models(): ModelProfile[];
}

export function adapterFor(model: ModelProfile): ModelAdapter {
	if (model.api === "anthropic") return anthropic;
	if (model.api === "openai-responses") return responsesAdapter(model.toolNamespace);
	return openaiChat;
}

/** Apply config.json overrides by full reference first, then by model id. */
export function applyOverride(model: ModelProfile, overrides: Record<string, ModelOverride>): ModelProfile {
	const o = { ...overrides[model.id], ...overrides[model.ref] };
	return {
		...model,
		context: o.context ?? model.context,
		maxOutput: o.maxOutput ?? model.maxOutput,
		vision: o.vision ?? model.vision,
		efforts: o.efforts ?? model.efforts,
		defaultEffort: o.defaultEffort ?? model.defaultEffort,
		effortField: o.effortField ?? model.effortField,
		replayReasoning: o.replayReasoning ?? model.replayReasoning,
		temperature: o.temperature ?? model.temperature,
		instructions: o.instructions ?? model.instructions,
	};
}

export function toInfo(m: ModelProfile): ModelInfo {
	return {
		ref: m.ref,
		provider: m.provider,
		id: m.id,
		label: m.label,
		source: m.source,
		context: m.context,
		maxOutput: m.maxOutput,
		vision: m.vision,
		efforts: m.efforts,
		defaultEffort: m.defaultEffort,
	};
}

interface ListedModel {
	id?: string;
	max_model_len?: number;
	context_length?: number;
	max_context_length?: number;
	/** Anthropic's Models API: the context window and the output cap. */
	max_input_tokens?: number;
	max_tokens?: number;
	meta?: { n_ctx_train?: number; n_ctx?: number };
}

function contextOf(entry: ListedModel): number {
	const value = entry.max_model_len ?? entry.max_input_tokens ?? entry.max_context_length ?? entry.context_length ?? entry.meta?.n_ctx ?? entry.meta?.n_ctx_train;
	return typeof value === "number" && value > 0 ? value : DEFAULT_CONTEXT;
}

/** Guess reasoning support from the name; config.json overrides it. Families that think by default get levels. */
function guessReasoning(id: string): Pick<ModelProfile, "efforts" | "effortField" | "replayReasoning"> {
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

async function listModels(baseUrl: string, headers: Record<string, string>, timeoutMs: number, ca?: string): Promise<ListedModel[]> {
	const response = await labFetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
		headers: { accept: "application/json", ...headers },
		signal: AbortSignal.timeout(timeoutMs),
		ca,
	});
	if (!response.ok) throw new Error(`answered ${response.status}`);
	const body = (await response.json()) as { data?: ListedModel[]; models?: ListedModel[] };
	return (body.data ?? body.models ?? []).filter((m) => typeof m.id === "string");
}

function plainProfile(provider: string, label: string, baseUrl: string, entry: ListedModel, source: ModelProfile["source"], extra: Partial<ModelProfile> = {}): ModelProfile {
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
		vision: /vl|vision|llava|gemma-?3|qwen3\.[5-9]|pixtral|llama-?4/i.test(id),
		...guessReasoning(id),
		headers: async () => ({}),
		...extra,
	};
}

export class ModelRegistry {
	private local: ModelProfile[] = [];
	private configured: ModelProfile[] = [];
	private sources: ModelSource[] = [];
	readonly problems = new Map<string, string>();

	constructor(
		private config: () => LabConfig,
		private credentials = "",
	) {}

	addSource(source: ModelSource): void {
		this.sources = [...this.sources.filter((s) => s.name !== source.name), source];
	}

	removeSource(name: string): void {
		this.sources = this.sources.filter((s) => s.name !== name);
	}

	/** Look for local servers and list configured providers. Each probe is short and they run at once. */
	async refresh(): Promise<void> {
		const config = this.config();
		this.problems.clear();
		const localJobs = config.discovery.local
			? LOCAL_SERVERS.map(async (server) => {
					try {
						const listed = await listModels(server.baseUrl, {}, 600);
						return listed.map((m) => plainProfile(server.name, server.label, server.baseUrl, m, "local"));
					} catch {
						return [];
					}
				})
			: [];
		const configJobs = Object.entries(config.providers).map(async ([name, provider]) => {
			try {
				return await this.configuredModels(name, provider);
			} catch (error) {
				this.problems.set(name, errorText(error));
				return [];
			}
		});
		const [local, configured] = await Promise.all([Promise.all(localJobs), Promise.all(configJobs)]);
		this.local = local.flat();
		this.configured = configured.flat();
	}

	private async configuredModels(name: string, provider: ProviderConfig): Promise<ModelProfile[]> {
		if (provider.auth === "chatgpt") return this.planModels(name, provider);
		const ca = provider.caFile ? readFileSync(expandHome(provider.caFile), "utf8") : undefined;
		const headers = async (): Promise<Record<string, string>> => {
			const key = provider.keychain ? await loadKey(this.credentials, name) : readSecret(provider);
			const auth: Record<string, string> = {};
			if (key) {
				if (provider.api === "anthropic") auth["x-api-key"] = key;
				else auth.authorization = `Bearer ${key}`;
			}
			if (provider.api === "anthropic") auth["anthropic-version"] = "2023-06-01";
			return { ...provider.headers, ...auth };
		};
		const label = provider.label ?? name;
		let listed: ListedModel[];
		if (provider.models?.length) listed = provider.models.map((id) => ({ id }));
		else listed = await listModels(provider.baseUrl, await headers(), 5000, ca);
		return listed.map((entry) =>
			plainProfile(name, label, provider.baseUrl, entry, "config", {
				api: provider.api,
				headers,
				ca,
				...(provider.api === "anthropic"
					? {
							context: entry.max_input_tokens ?? 200_000,
							maxOutput: Math.min(entry.max_tokens ?? 64_000, 64_000),
							vision: true,
							efforts: ["low", "medium", "high", "xhigh", "max"],
							defaultEffort: "high",
							effortField: "none" as const,
							replayReasoning: true,
						}
					: {}),
			}),
		);
	}

	/** The models of a signed-in ChatGPT account, on its plan. */
	private async planModels(name: string, provider: ProviderConfig): Promise<ModelProfile[]> {
		const headers = async () => ({ authorization: `Bearer ${await accessToken(this.credentials)}` });
		const listed = await planModels(await accessToken(this.credentials));
		const label = provider.label ?? "ChatGPT";
		return listed.map((m) => ({
			ref: `${name}/${m.id}`,
			provider: name,
			id: m.id,
			label: `${m.label} · ${label}`,
			source: "config" as const,
			api: "openai-responses" as const,
			baseUrl: provider.baseUrl,
			context: m.context ?? 200_000,
			maxOutput: 128_000,
			vision: m.vision,
			efforts: m.efforts,
			defaultEffort: m.defaultEffort ?? (m.efforts.includes("medium") ? "medium" : undefined),
			effortField: "none" as const,
			replayReasoning: true,
			headers,
			toolNamespace: TOOL_NAMESPACE,
		}));
	}

	all(): ModelProfile[] {
		const overrides = this.config().models;
		const seen = new Set<string>();
		const out: ModelProfile[] = [];
		for (const model of [...this.sources.flatMap((s) => s.models()), ...this.configured, ...this.local]) {
			if (seen.has(model.ref)) continue;
			seen.add(model.ref);
			out.push(applyOverride(model, overrides));
		}
		return out;
	}

	list(): ModelInfo[] {
		return this.all().map(toInfo);
	}

	/** Find a model by full reference, or by id when only one provider has it. */
	resolve(ref: string | undefined): ModelProfile | undefined {
		if (!ref) return undefined;
		const all = this.all();
		return all.find((m) => m.ref === ref) ?? (all.filter((m) => m.id === ref).length === 1 ? all.find((m) => m.id === ref) : undefined);
	}

	/** The configured default if it exists, else a site model, else anything. */
	preferred(): ModelProfile | undefined {
		const all = this.all();
		return this.resolve(this.config().model) ?? all.find((m) => m.source === "site") ?? all.find((m) => m.source === "config") ?? all[0];
	}
}
