// Every model the person can use right now, from three places: model servers on this computer (models/local.ts),
// providers in config.json, and signed-in sites. A model reference is `<provider>/<model id>`.

import { readFileSync } from "node:fs";
import type { ModelInfo, ModelWhere } from "@enrichedlab/protocol";
import { localHost, loopbackHost } from "../permissions.ts";
import type { LabConfig, ModelOverride, ProviderConfig } from "../config.ts";
import { errorText, expandHome, readSecret } from "../util.ts";
import { openaiChat } from "./openai_chat.ts";
import { anthropic } from "./anthropic.ts";
import { accessToken, planModels } from "./chatgpt.ts";
import { responsesAdapter, TOOL_NAMESPACE } from "./openai_responses.ts";
import { discoverLocal, type LocalServer, localContextCap, ollamaProfiles } from "./local.ts";
import { ollamaChat } from "./ollama.ts";
import { type ListedModel, listModels, plainProfile } from "./profiles.ts";
import { loadKey } from "./providers.ts";
import type { ModelAdapter, ModelProfile } from "./types.ts";

/** Something that contributes models (a site). */
export interface ModelSource {
	name: string;
	models(): ModelProfile[];
}

export function adapterFor(model: ModelProfile): ModelAdapter {
	if (model.api === "anthropic") return anthropic;
	if (model.api === "openai-responses") return responsesAdapter(model.toolNamespace);
	if (model.api === "ollama") return ollamaChat;
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

/**
 * Where a model runs: what its source says (a lab), or else its address: this computer, a private address on the
 * person's network, or a cloud service named as its provider is.
 */
export function whereOf(m: Pick<ModelProfile, "where" | "baseUrl" | "label" | "provider">): ModelWhere {
	if (m.where) return m.where;
	let host = "";
	try {
		host = new URL(m.baseUrl).host;
	} catch {
		// No address to go by: say cloud, the cautious answer.
	}
	if (host && loopbackHost(host)) return { kind: "device", name: "this computer" };
	if (host && localHost(host)) return { kind: "network", name: new URL(m.baseUrl).hostname };
	return { kind: "cloud", name: m.label.split(" · ").at(-1) || m.provider };
}

export function toInfo(m: ModelProfile): ModelInfo {
	return {
		ref: m.ref,
		provider: m.provider,
		id: m.id,
		label: m.label,
		source: m.source,
		where: whereOf(m),
		context: m.context,
		maxOutput: m.maxOutput,
		vision: m.vision,
		efforts: m.efforts,
		defaultEffort: m.defaultEffort,
	};
}

export class ModelRegistry {
	private local: ModelProfile[] = [];
	/** The model servers found on this computer at the last refresh. */
	servers: LocalServer[] = [];
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
		const localJob = config.discovery.local ? discoverLocal(config.discovery.ports).catch(() => [] as LocalServer[]) : Promise.resolve([] as LocalServer[]);
		const configJobs = Object.entries(config.providers).map(async ([name, provider]) => {
			try {
				return await this.configuredModels(name, provider);
			} catch (error) {
				this.problems.set(name, errorText(error));
				return [];
			}
		});
		const [servers, configured] = await Promise.all([localJob, Promise.all(configJobs)]);
		this.servers = servers;
		this.local = servers.flatMap((server) => server.models);
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
		// An Ollama elsewhere on the network: its own API, so the context window can be set.
		if (provider.api === "ollama") {
			const models = await ollamaProfiles(name, label, provider.baseUrl, localContextCap(), "config", 5000);
			return models.map((m) => ({ ...m, headers, ca }));
		}
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

	/** Former provider names (a renamed lab) mapped to the names now. */
	aliases: () => Record<string, string> = () => ({});

	/** Find a model by full reference, or by id when only one provider has it. A renamed lab's old name still works. */
	resolve(ref: string | undefined): ModelProfile | undefined {
		if (!ref) return undefined;
		const slash = ref.indexOf("/");
		const renamed = slash > 0 ? this.aliases()[ref.slice(0, slash)] : undefined;
		if (renamed) ref = `${renamed}${ref.slice(slash)}`;
		const all = this.all();
		return all.find((m) => m.ref === ref) ?? (all.filter((m) => m.id === ref).length === 1 ? all.find((m) => m.id === ref) : undefined);
	}

	/** The configured default if it exists, else a site model, else anything. */
	preferred(): ModelProfile | undefined {
		const all = this.all();
		return this.resolve(this.config().model) ?? all.find((m) => m.source === "site") ?? all.find((m) => m.source === "config") ?? all[0];
	}
}
