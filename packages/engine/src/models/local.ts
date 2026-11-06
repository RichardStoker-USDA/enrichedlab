// Model servers on this computer, found by how they answer rather than by port: llama.cpp and mlx_lm.server both
// default to 8080, and vLLM and oMLX to 8000. Each kind then adds what it knows about its models' context, so the
// harness never plans for more context than the server will hold.

import { totalmem } from "node:os";
import { labFetch } from "./http.ts";
import { OLLAMA_MLX_DEFAULT, type OllamaModel, atLeast, ollamaModels, ollamaVersion } from "./ollama.ts";
import { type ListedModel, guessVision, plainProfile } from "./profiles.ts";
import type { ModelProfile } from "./types.ts";

/** Default ports: Ollama, LM Studio, llama.cpp or mlx_lm.server, vLLM or oMLX, SGLang. */
export const LOCAL_PORTS = [11434, 1234, 8080, 8000, 30000];

export type LocalKind = "ollama" | "lmstudio" | "llamacpp" | "vllm" | "sglang" | "omlx" | "mlx" | "openai";

const LABELS: Record<LocalKind, string> = {
	ollama: "Ollama",
	lmstudio: "LM Studio",
	llamacpp: "llama.cpp",
	vllm: "vLLM",
	sglang: "SGLang",
	omlx: "oMLX",
	mlx: "MLX",
	openai: "Local server",
};

/** What each server puts in `owned_by` (from their sources: llama.cpp, vLLM, SGLang, oMLX). */
const OWNERS: Record<string, LocalKind> = { llamacpp: "llamacpp", vllm: "vllm", sglang: "sglang", omlx: "omlx" };

export interface LocalServer {
	/** Provider name in model references: the kind, or kind-port when two of a kind run. */
	name: string;
	kind: LocalKind;
	label: string;
	port: number;
	baseUrl: string;
	version?: string;
	models: ModelProfile[];
}

/**
 * The context to ask a local server for when the model allows more: room for agent work without a KV cache that
 * crowds out the model on smaller machines. config.json `models.<ref>.context` overrides it.
 */
export function localContextCap(memoryBytes = totalmem()): number {
	const gib = memoryBytes / 2 ** 30;
	return gib >= 64 ? 65_536 : gib >= 32 ? 32_768 : 16_384;
}

async function getJson(url: string, timeoutMs: number): Promise<{ ok: boolean; body?: unknown; server: string }> {
	try {
		const response = await labFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
		const server = response.headers.get("server") ?? "";
		if (!response.ok) return { ok: false, server };
		return { ok: true, body: await response.json().catch(() => undefined), server };
	} catch {
		return { ok: false, server: "" };
	}
}

/** Which server answers on `port`, and its listing; undefined when nothing OpenAI-compatible does. */
export async function identify(port: number, timeoutMs = 600, host = "127.0.0.1"): Promise<{ kind: LocalKind; baseUrl: string; listed: ListedModel[]; version?: string } | undefined> {
	const root = `http://${host}:${port}`;
	const models = await getJson(`${root}/v1/models`, timeoutMs);
	if (!models.ok) return undefined;
	const body = models.body as { data?: ListedModel[] | null } | undefined;
	const listed = (body?.data ?? []).filter((m) => typeof m?.id === "string");
	const baseUrl = `${root}/v1`;
	const owner = listed.find((m) => m.owned_by)?.owned_by;
	if (owner && OWNERS[owner]) return { kind: OWNERS[owner], baseUrl, listed };
	const version = await ollamaVersion(root, timeoutMs);
	if (version) return { kind: "ollama", baseUrl, listed, version };
	const studio = await getJson(`${root}/api/v1/models`, timeoutMs);
	if (studio.ok && Array.isArray((studio.body as { models?: unknown })?.models)) return { kind: "lmstudio", baseUrl, listed };
	// mlx_lm.server runs on Python's http.server and lists models without owned_by.
	if (!owner && /python/i.test(models.server)) return { kind: "mlx", baseUrl, listed };
	return { kind: "openai", baseUrl, listed };
}

/** One Ollama model as a profile: the context it will hold, and its capabilities when Ollama reports them. */
export function ollamaProfile(name: string, label: string, baseUrl: string, m: OllamaModel, cap: number, source: ModelProfile["source"]): ModelProfile {
	const thinks = m.capabilities.includes("thinking");
	const known = m.capabilities.length > 0;
	return {
		...plainProfile(name, label, baseUrl, { id: m.name }, source),
		api: "ollama",
		context: Math.min(m.trained ?? cap, cap),
		...(known ? { vision: m.capabilities.includes("vision"), efforts: thinks ? ["off", "low", "medium", "high"] : [], effortField: "none" as const, replayReasoning: thinks } : {}),
	};
}

/** Ollama's models that chat (not embedding models), each asked for with a context it will hold. */
export async function ollamaProfiles(name: string, label: string, baseUrl: string, cap: number, source: ModelProfile["source"] = "local", timeoutMs?: number): Promise<ModelProfile[]> {
	const models = await ollamaModels(baseUrl, timeoutMs);
	return models.filter((m) => !m.capabilities.length || m.capabilities.includes("completion")).map((m) => ollamaProfile(name, label, baseUrl, m, cap, source));
}

interface StudioModel {
	type?: string;
	key: string;
	display_name?: string;
	max_context_length?: number;
	vision?: boolean;
	capabilities?: { vision?: boolean };
	loaded_instances?: { config?: { context_length?: number } }[];
}

/**
 * LM Studio's models. One not loaded yet would load with LM Studio's default context on first use, so the profile
 * loads it first with the context the harness plans for.
 */
async function studioProfiles(name: string, label: string, baseUrl: string, cap: number): Promise<ModelProfile[]> {
	const root = baseUrl.replace(/\/v1$/, "");
	const listing = await getJson(`${root}/api/v1/models`, 2000);
	const models = ((listing.body as { models?: StudioModel[] })?.models ?? []).filter((m) => m.type === "llm" && typeof m.key === "string");
	return models.map((m) => {
		const loaded = m.loaded_instances?.[0]?.config?.context_length;
		const context = loaded ?? Math.min(m.max_context_length ?? cap, cap);
		let ready = Boolean(loaded);
		return {
			...plainProfile(name, label, baseUrl, { id: m.key }, "local"),
			label: `${m.display_name ?? m.key} · ${label}`,
			context,
			vision: m.capabilities?.vision ?? m.vision ?? guessVision(m.key),
			prepare: async (signal: AbortSignal) => {
				if (ready) return;
				const now = await getJson(`${root}/api/v1/models`, 2000);
				const entry = ((now.body as { models?: StudioModel[] })?.models ?? []).find((x) => x.key === m.key);
				if (!entry?.loaded_instances?.length) {
					const response = await labFetch(`${root}/api/v1/models/load`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.key, context_length: context }), signal });
					if (!response.ok) throw new Error(`LM Studio couldn't load ${m.key} (${response.status}).`);
				}
				ready = true;
			},
		};
	});
}

/** Find the servers on `ports` and list their models. Probes are short and run at once; silence means none. */
export async function discoverLocal(ports: number[] = LOCAL_PORTS, timeoutMs = 600, cap = localContextCap()): Promise<LocalServer[]> {
	const found = (await Promise.all(ports.map(async (port) => ({ port, at: await identify(port, timeoutMs) })))).filter((f) => f.at);
	const taken = new Set<string>();
	const servers: LocalServer[] = [];
	for (const { port, at } of found) {
		const { kind, baseUrl, listed, version } = at!;
		const name = taken.has(kind) ? `${kind}-${port}` : kind;
		taken.add(name);
		const label = kind === "openai" ? `${LABELS.openai} :${port}` : LABELS[kind];
		let models: ModelProfile[];
		try {
			if (kind === "ollama") models = await ollamaProfiles(name, label, baseUrl, cap);
			else if (kind === "lmstudio") models = await studioProfiles(name, label, baseUrl, cap);
			else models = listed.map((m) => plainProfile(name, label, baseUrl, m, "local"));
		} catch {
			models = listed.map((m) => plainProfile(name, label, baseUrl, m, "local"));
		}
		servers.push({ name, kind, label, port, baseUrl, version, models });
	}
	return servers;
}

/** Whether this Ollama runs models on MLX by default (Apple silicon, 0.40.0 or later). */
export function ollamaUsesMlx(version: string | undefined, platform = process.platform, arch = process.arch): boolean {
	return platform === "darwin" && arch === "arm64" && Boolean(version && atLeast(version, OLLAMA_MLX_DEFAULT));
}
