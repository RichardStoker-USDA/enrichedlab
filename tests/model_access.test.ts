// When the model a session uses goes away (a local server stopped, or a lab changed what the person may use), the
// session stops and says so instead of moving the conversation to some other model on its own.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../packages/engine/src/config.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile } from "../packages/engine/src/models/types.ts";
import { SessionLog } from "../packages/engine/src/session/log.ts";
import { type RuntimeDeps, SessionRuntime } from "../packages/engine/src/session/runtime.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";

const dir = mkdtempSync(join(tmpdir(), "el-access-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// A lab that answers a model outside the person's grant as absent, the way Gate does.
let asked = 0;
const lab = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		// The session's own requests carry its system prompt; naming the session asks separately.
		const body = (await request.json()) as { messages?: { role: string; content: string }[] };
		if (body.messages?.[0]?.content === "You help.") asked++;
		return Response.json({ error: { code: "model_not_found", message: "No model named lab-model." } }, { status: 404 });
	},
});
afterAll(() => lab.stop(true));

const profile = (ref: string, source: ModelProfile["source"], baseUrl = "http://127.0.0.1:1/v1"): ModelProfile => ({
	ref,
	provider: ref.split("/")[0]!,
	id: ref.split("/").slice(1).join("/"),
	label: ref,
	source,
	api: "openai-chat",
	baseUrl,
	context: 32_768,
	maxOutput: 1024,
	vision: false,
	efforts: [],
	effortField: "none",
	replayReasoning: false,
	headers: async () => ({}),
});

function session(name: string, models: ModelProfile[], model: string): SessionRuntime {
	const registry = {
		resolve: (ref?: string) => models.find((m) => m.ref === ref),
		preferred: () => models[0],
		all: () => models,
	} as unknown as ModelRegistry;
	const deps = {
		config: () => DEFAULT_CONFIG,
		registry,
		tools: () => [],
		allows: () => true,
		spawn: () => "",
		waitAgents: async () => [],
		cancelChildren: () => undefined,
		canvas: { publish: () => undefined },
		notify: () => undefined,
		ask: async () => "allow",
	} as unknown as RuntimeDeps;
	const { log } = SessionLog.create(join(dir, name), dir, model, "You help.");
	return new SessionRuntime(log, new LocalWorkspace(dir), deps);
}

async function settle(runtime: SessionRuntime): Promise<void> {
	for (let i = 0; i < 200 && runtime.isRunning; i++) await Bun.sleep(10);
}

describe("a session whose model goes away", () => {
	test("stops and says so, rather than switching to another model", async () => {
		const other = profile("chatgpt/gpt-6", "config");
		const runtime = session("s1", [other], "ollama/qwen3:0.6b");
		runtime.prompt("hello");
		await settle(runtime);
		const notice = runtime.events.find((e) => e.t === "notice");
		expect(notice && "text" in notice ? notice.text : "").toBe("ollama/qwen3:0.6b isn't available now: its server may have stopped, or your access to it changed. Pick another model to go on.");
		expect(runtime.events.some((e) => e.t === "assistant")).toBe(false);
		expect(runtime.modelRef).toBe("ollama/qwen3:0.6b");
	});

	test("a lab answering the model as absent reads as an access change", async () => {
		const model = profile("devlab/lab-model", "site", `http://127.0.0.1:${lab.port}/v1`);
		const runtime = session("s2", [model], model.ref);
		runtime.prompt("hello");
		await settle(runtime);
		const answer = runtime.events.find((e) => e.t === "assistant");
		expect(answer && "error" in answer ? answer.error : "").toBe("devlab no longer offers lab-model to you; your access changed. Pick another model to go on.");
		// Not retried: an absent model stays absent.
		expect(asked).toBe(1);
	});
});
