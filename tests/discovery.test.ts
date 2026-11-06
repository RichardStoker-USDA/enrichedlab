// Discovery mode (docs/research.md): on only at a lab that grants it, told to the model without breaking a tool round,
// and a lab that keeps its sandboxes for its own agents refuses other models there.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "../packages/protocol/src/index.ts";
import { DEFAULT_CONFIG } from "../packages/engine/src/config.ts";
import { Engine } from "../packages/engine/src/engine.ts";
import type { ModelRegistry } from "../packages/engine/src/models/registry.ts";
import type { ModelProfile } from "../packages/engine/src/models/types.ts";
import { derive } from "../packages/engine/src/session/context.ts";
import { SessionLog } from "../packages/engine/src/session/log.ts";
import { type RuntimeDeps, SessionRuntime } from "../packages/engine/src/session/runtime.ts";
import { LocalWorkspace } from "../packages/engine/src/tools/workspace.ts";

const dir = mkdtempSync(join(tmpdir(), "el-discovery-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const profile = (ref: string, source: ModelProfile["source"]): ModelProfile => ({
	ref,
	provider: ref.split("/")[0]!,
	id: ref.split("/").slice(1).join("/"),
	label: ref,
	source,
	api: "openai-chat",
	baseUrl: "http://127.0.0.1:1/v1",
	context: 32_768,
	maxOutput: 1024,
	vision: false,
	efforts: [],
	effortField: "none",
	replayReasoning: false,
	headers: async () => ({}),
});

type Lab = ReturnType<NonNullable<RuntimeDeps["lab"]>>;

function session(name: string, models: ModelProfile[], model: string, lab: Lab): SessionRuntime {
	const registry = { resolve: (ref?: string) => models.find((m) => m.ref === ref), preferred: () => models[0], all: () => models } as unknown as ModelRegistry;
	const deps = {
		config: () => DEFAULT_CONFIG,
		registry,
		tools: () => [],
		allows: () => true,
		lab: () => lab,
		spawn: () => "",
		waitAgents: async () => [],
		cancelChildren: () => undefined,
		canvas: { publish: () => undefined },
		notify: () => undefined,
		ask: async () => "allow",
	} as unknown as RuntimeDeps;
	const { log } = SessionLog.create(join(dir, name), dir, model, "You help.");
	const runtime = new SessionRuntime(log, new LocalWorkspace(dir), deps);
	runtime.append({ t: "place", id: "e-place", at: new Date().toISOString(), place: "field", label: "the Field Lab sandbox", root: "/sandbox/work/p1" });
	return runtime;
}

/** The engine's discover() with only the sites it reads. */
function discover(runtime: SessionRuntime, on: boolean, lab: Lab): string {
	const sites = { lab: () => lab, title: () => "Field Lab" };
	return Engine.prototype.discover.call({ sites } as never, runtime, on);
}

describe("Discovery mode", () => {
	test("turns on only at a lab that grants it, and the model is told", () => {
		const model = profile("field/reasoner", "site");
		const runtime = session("d1", [model], model.ref, { title: "Field Lab", capabilities: [] });
		expect(() => discover(runtime, true, { title: "Field Lab", capabilities: [] })).toThrow("Field Lab hasn't given you Discovery mode.");
		expect(() => discover(runtime, true, undefined)).toThrow("Field Lab isn't connected.");
		expect(discover(runtime, true, { title: "Field Lab", capabilities: ["discovery"] })).toStartWith("Discovery mode is on. At Field Lab, the agent works without asking");
		expect(runtime.discovery).toBe("field");
		expect(runtime.summary().discovery).toBe("field");
		expect(discover(runtime, true, { title: "Field Lab", capabilities: ["discovery"] })).toBe("Discovery mode is already on.");
		expect(discover(runtime, false, { title: "Field Lab", capabilities: ["discovery"] })).toStartWith("Discovery mode is off.");
		expect(runtime.discovery).toBeUndefined();
		const told = derive(runtime.events).messages.filter((m) => m.role === "user").map((m) => (m.role === "user" && m.content[0]?.type === "text" ? m.content[0].text : ""));
		expect(told.some((text) => text.startsWith("(The person turned on Discovery mode"))).toBe(true);
		expect(told.at(-1)).toStartWith("(Discovery mode is off.");
	});

	test("is refused in a session on this computer", () => {
		const model = profile("field/reasoner", "site");
		const { log } = SessionLog.create(join(dir, "d2"), dir, model.ref, "You help.");
		const runtime = new SessionRuntime(log, new LocalWorkspace(dir), { config: () => DEFAULT_CONFIG, notify: () => undefined } as unknown as RuntimeDeps);
		expect(() => discover(runtime, true, { title: "Field Lab", capabilities: ["discovery"] })).toThrow("Discovery mode works in a session at a lab.");
	});

	test("turned on mid-turn, the model hears it after the open tool calls are answered", () => {
		const at = new Date().toISOString();
		const events: SessionEvent[] = [
			{ t: "header", v: 1, id: "h", at, cwd: dir, created: at },
			{ t: "user", id: "u", at, text: "Analyze the plots." },
			{ t: "assistant", id: "a", at, model: "field/reasoner", text: "", toolCalls: [{ id: "c1", name: "shell", args: "{}" }], stop: "tool_use" },
			{ t: "discovery", id: "d", at, on: true, site: "field" },
			{ t: "tool", id: "r", at, callId: "c1", name: "shell", ok: true, content: "done" },
		];
		const roles = derive(events).messages.map((m) => m.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user"]);
	});

	test("a lab that keeps its sandboxes for its own agents refuses another model working there", async () => {
		const cloud = profile("chatgpt/gpt-6", "config");
		const runtime = session("d3", [cloud], cloud.ref, { title: "Field Lab", capabilities: [], sandboxAgents: "lab" });
		runtime.prompt("hello");
		for (let i = 0; i < 200 && runtime.isRunning; i++) await Bun.sleep(10);
		const notice = runtime.events.find((e) => e.t === "notice");
		expect(notice && "text" in notice ? notice.text : "").toBe("Field Lab runs its sandboxes for its own models only. Pick one of Field Lab's models to go on.");
		expect(runtime.events.some((e) => e.t === "assistant")).toBe(false);
	});
});
