// Model servers on this computer, against stand-ins: each kind is told apart by how it answers (llama.cpp and
// mlx_lm.server share 8080, vLLM and oMLX share 8000), Ollama is asked through its own API with a context it will hold,
// downloads report progress summed over layers, and LM Studio loads a model with the planned context before use.

import { afterAll, describe, expect, test } from "bun:test";
import type { LocalPullProgress } from "../packages/protocol/src/index.ts";
import { discoverLocal, foundryPort, identify, localContextCap, ollamaUsesMlx } from "../packages/engine/src/models/local.ts";
import { LocalModels } from "../packages/engine/src/models/local_service.ts";
import { atLeast, ollamaBody, ollamaChat } from "../packages/engine/src/models/ollama.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile, StreamEvent } from "../packages/engine/src/models/types.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
const serve = (fetch: (request: Request) => Response | Promise<Response>) => {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
	servers.push(server);
	return server.port!;
};
afterAll(() => servers.forEach((s) => s.stop(true)));

const listing = (entries: object[], headers: Record<string, string> = {}) => Response.json({ object: "list", data: entries }, { headers });
const missing = () => new Response("", { status: 404 });

// What each server answers, from their sources.
const llamacpp = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "qwen.gguf", owned_by: "llamacpp", meta: { n_ctx: 16384, n_ctx_train: 262144 } }]) : missing()));
const vllm = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "Qwen/Qwen3.8-27B", owned_by: "vllm", max_model_len: 131072 }]) : missing()));
const sglang = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "glm-5.3", owned_by: "sglang", max_model_len: 65536 }]) : missing()));
const omlx = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "gemma-4-mlx", owned_by: "omlx", max_model_len: 32768 }]) : missing()));
const mlx = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "mlx-community/Qwen3.8-27B-4bit", object: "model", created: 1 }], { server: "BaseHTTP/0.6 Python/3.12.4" }) : missing()));
const other = serve((r) => (new URL(r.url).pathname === "/v1/models" ? listing([{ id: "mystery" }]) : missing()));

// Ollama: its API, a thinking model with tools, and a pull in two layers.
const chats: Record<string, unknown>[] = [];
let refuseLevels = false;
const ollama = serve(async (r) => {
	const path = new URL(r.url).pathname;
	if (path === "/v1/models") return listing([{ id: "qwen3.8:27b", owned_by: "library" }]);
	if (path === "/api/version") return Response.json({ version: "0.40.14" });
	if (path === "/api/tags") return Response.json({ models: [{ name: "qwen3.8:27b", size: 18e9, details: { family: "qwen3" } }, { name: "embeddinggemma-2", size: 6e8 }] });
	if (path === "/api/show") {
		const { model } = (await r.json()) as { model: string };
		return model === "qwen3.8:27b"
			? Response.json({ model_info: { "qwen3.context_length": 262144 }, capabilities: ["completion", "tools", "thinking", "vision"] })
			: Response.json({ model_info: { "gemma.context_length": 2048 }, capabilities: ["embedding"] });
	}
	if (path === "/api/chat") {
		const body = (await r.json()) as Record<string, unknown>;
		chats.push(body);
		if (refuseLevels && typeof body.think === "string") return Response.json({ error: "think value \"high\" is not supported for this model" }, { status: 400 });
		const lines = [
			{ message: { role: "assistant", content: "", thinking: "Need the file." }, done: false },
			{ message: { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "README.md" } } }] }, done: false },
			{ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 30 },
		];
		return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson" } });
	}
	if (path === "/api/pull") {
		const steps = [
			{ status: "pulling manifest" },
			{ status: "pulling aaaaaaaaaaaa", digest: "sha256:aaaaaaaaaaaa", total: 1000, completed: 500 },
			{ status: "pulling bbbbbbbbbbbb", digest: "sha256:bbbbbbbbbbbb", total: 3000, completed: 3000 },
			{ status: "pulling aaaaaaaaaaaa", digest: "sha256:aaaaaaaaaaaa", total: 1000, completed: 1000 },
			{ status: "verifying sha256 digest" },
			{ status: "success" },
		];
		return new Response(steps.map((l) => JSON.stringify(l)).join("\n") + "\n");
	}
	return missing();
});

// LM Studio: its v1 REST API, one model not loaded yet.
const loads: Record<string, unknown>[] = [];
const studio = serve(async (r) => {
	const path = new URL(r.url).pathname;
	if (path === "/v1/models") return listing([{ id: "openai/gpt-oss-20b", owned_by: "organization_owner" }]);
	if (path === "/api/v1/models") return Response.json({ models: [{ type: "llm", key: "openai/gpt-oss-20b", display_name: "gpt-oss 20B", max_context_length: 131072, loaded_instances: loads.length ? [{ config: { context_length: 65536 } }] : [] }, { type: "embedding", key: "nomic" }] });
	if (path === "/api/v1/models/load") return loads.push((await r.json()) as Record<string, unknown>), Response.json({ status: "loaded" });
	if (path === "/v1/chat/completions") return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	return missing();
});

const GiB = 2 ** 30;

describe("finding model servers on this computer", () => {
	test("each server is told apart by its answer, not its port", async () => {
		const kinds = await Promise.all([llamacpp, vllm, sglang, omlx, mlx, ollama, studio, other].map(async (port) => (await identify(port))?.kind));
		expect(kinds).toEqual(["llamacpp", "vllm", "sglang", "omlx", "mlx", "ollama", "lmstudio", "openai"]);
		const closed = serve(() => missing());
		expect(await identify(closed)).toBeUndefined();
	});

	test("each model gets the context its server holds, and two of a kind are named apart", async () => {
		const found = await discoverLocal([llamacpp, vllm, sglang, ollama, studio, vllm], 600, 65_536);
		const byRef = Object.fromEntries(found.flatMap((s) => s.models).map((m) => [m.ref, m]));
		expect(byRef["llamacpp/qwen.gguf"]?.context).toBe(16384);
		expect(byRef["vllm/Qwen/Qwen3.8-27B"]?.context).toBe(131072);
		expect(byRef["sglang/glm-5.3"]?.label).toBe("glm-5.3 · SGLang");
		expect(found.map((s) => s.name)).toContain(`vllm-${vllm}`);
		// Ollama: trained for 256K, asked for the cap; embedding models aren't offered to chat.
		expect(byRef["ollama/qwen3.8:27b"]).toMatchObject({ api: "ollama", context: 65_536, vision: true, efforts: ["off", "low", "medium", "high"] });
		expect(byRef["ollama/embeddinggemma-2"]).toBeUndefined();
		// LM Studio: chat models only, planned at the cap below the model's maximum.
		expect(byRef["lmstudio/openai/gpt-oss-20b"]).toMatchObject({ label: "gpt-oss 20B · LM Studio", context: 65_536 });
		expect(byRef["lmstudio/nomic"]).toBeUndefined();
	});

	test("the context asked for scales with memory", () => {
		expect([localContextCap(8 * GiB), localContextCap(32 * GiB), localContextCap(128 * GiB)]).toEqual([16_384, 32_768, 65_536]);
	});

	test("Ollama runs on MLX by default from 0.40.0, on Apple silicon only", () => {
		expect(atLeast("0.40.14", "0.40.0")).toBe(true);
		expect(atLeast("0.20.2", "0.40.0")).toBe(false);
		expect(atLeast("v0.40.0-rc2", "0.40.0")).toBe(true);
		expect(ollamaUsesMlx("0.40.14", "darwin", "arm64")).toBe(true);
		expect(ollamaUsesMlx("0.40.14", "linux", "x64")).toBe(false);
		expect(ollamaUsesMlx("0.20.2", "darwin", "arm64")).toBe(false);
	});
});

describe("Ollama's own API", () => {
	const model = async (): Promise<ModelProfile> => (await discoverLocal([ollama], 600, 32_768))[0]!.models[0]!;
	const run = async (effort?: string) => {
		const events: StreamEvent[] = [];
		const m = await model();
		for await (const e of ollamaChat.stream({ model: m, system: "Be brief.", messages: [{ role: "user", content: [{ type: "text", text: "Read README.md" }] }], tools: [{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }], effort, maxTokens: 2048 }, AbortSignal.timeout(5000))) events.push(e);
		return events;
	};

	test("asks for the planned context and streams thinking and tool calls", async () => {
		const events = await run("high");
		const body = chats.at(-1)!;
		expect(body.options).toMatchObject({ num_ctx: 32_768, num_predict: 2048 });
		expect(body.think).toBe("high");
		expect(body.tools).toHaveLength(1);
		expect(events.find((e) => e.type === "reasoning")).toEqual({ type: "reasoning", delta: "Need the file." });
		expect(events.find((e) => e.type === "tool_args")).toEqual({ type: "tool_args", index: 0, delta: '{"path":"README.md"}' });
		expect(events.at(-2)).toEqual({ type: "usage", usage: { input: 120, output: 30 } });
		expect(events.at(-1)).toEqual({ type: "done", stop: "tool_use" });
	});

	test("a model that takes no thinking levels is asked again with thinking on", async () => {
		refuseLevels = true;
		try {
			await run("high");
			expect(chats.slice(-2).map((c) => c.think)).toEqual(["high", true]);
		} finally {
			refuseLevels = false;
		}
	});

	test("tool results go back by name, arguments as objects, and text-only requests leave tools out", async () => {
		const m = await model();
		const body = ollamaBody({
			model: m,
			system: "",
			messages: [
				{ role: "user", content: [{ type: "text", text: "go" }] },
				{ role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"a.txt"}' }] },
				{ role: "tool", callId: "c1", name: "read_file", content: "hello" },
			],
			tools: [{ name: "read_file", description: "", parameters: {} }],
			toolChoice: "none",
		});
		expect(body.messages).toEqual([
			{ role: "user", content: "go" },
			{ role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: { path: "a.txt" } } }] },
			{ role: "tool", content: "hello", tool_name: "read_file" },
		]);
		expect(body.tools).toBeUndefined();
	});
});

describe("downloading and loading local models", () => {
	test("a download reports progress summed over its layers, then says it's ready", async () => {
		const found = await discoverLocal([ollama], 600, 32_768);
		const registry = { servers: found, refresh: async () => undefined } as unknown as ModelRegistry;
		const seen: LocalPullProgress[] = [];
		const done = new Promise<void>((resolve) => {
			const local = new LocalModels(registry, (p) => (seen.push(p), p.done ? resolve() : undefined), 64 * GiB);
			void local.pull("qwen3.8:27b");
		});
		await done;
		expect(seen.at(-1)).toMatchObject({ model: "qwen3.8:27b", status: "ready", done: true, completed: 4000, total: 4000 });
		expect(seen.some((p) => p.status === "verifying sha256 digest")).toBe(true);
		const status = await new LocalModels(registry, () => undefined, 16 * GiB).status();
		expect(status.ollama).toMatchObject({ name: "ollama", version: "0.40.14" });
		expect(status.suggestions.find((s) => s.model === "qwen3.8:27b")).toMatchObject({ installed: true, fits: false });
		expect(status.suggestions.find((s) => s.model === "lfm3:1.7b")).toMatchObject({ installed: false, fits: true });
	});

	test("a model name that isn't one is refused before anything is asked", async () => {
		const local = new LocalModels({ servers: [], refresh: async () => undefined } as unknown as ModelRegistry, () => undefined);
		await expect(local.pull("bad name!")).rejects.toThrow("That isn't an Ollama model name");
		await expect(local.pull("qwen3.8:27b")).rejects.toThrow("Ollama isn't running on this computer");
	});

	test("LM Studio loads a model with the planned context before its first request, once", async () => {
		const [server] = await discoverLocal([studio], 600, 65_536);
		const m = server!.models[0]!;
		const { openaiChat } = await import("../packages/engine/src/models/openai_chat.ts");
		for (let i = 0; i < 2; i++) for await (const _ of openaiChat.stream({ model: m, system: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [] }, AbortSignal.timeout(5000)));
		expect(loads).toEqual([{ model: "openai/gpt-oss-20b", context_length: 65_536 }]);
	});
});

describe("Foundry Local", () => {
	test("its CLI says the port, in the current and the older output", async () => {
		const current = async (_f: string, args: string[]) => (args[0] === "status" ? JSON.stringify({ server: { running: true, urls: ["http://127.0.0.1:51234"] } }) : "");
		expect(await foundryPort(current)).toBe(51234);
		const older = async (_f: string, args: string[]) => (args[0] === "service" ? "Model management service is running on http://127.0.0.1:5273/openai/status" : "");
		expect(await foundryPort(older)).toBe(5273);
		expect(await foundryPort(async () => "")).toBeUndefined();
	});

	test("the server its CLI names is listed as Foundry Local", async () => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ object: "list", data: [{ id: "qwen3-0.6b", object: "model" }] }) });
		try {
			const run = async (_f: string, args: string[]) => (args[0] === "status" ? `{"url":"http://127.0.0.1:${server.port}"}` : "");
			const found = await discoverLocal([], 600, 32_768, run);
			expect(found.map((s) => [s.kind, s.label, s.models.map((m) => m.id)])).toEqual([["foundry", "Foundry Local", ["qwen3-0.6b"]]]);
		} finally {
			server.stop(true);
		}
	});
});
