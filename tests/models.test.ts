// The request each adapter sends, captured from a local stand-in server: caching, tool choice, and the summary
// request's shape. No provider is called.

import { afterAll, describe, expect, test } from "bun:test";
import type { ModelProfile, Msg } from "../packages/engine/src/models/types.ts";
import { anthropic } from "../packages/engine/src/models/anthropic.ts";
import { prepareForSummary, summarize } from "../packages/engine/src/session/compaction.ts";

const bodies: Record<string, unknown>[] = [];
const sse = (events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const text = "## Goal\nKeep the calculator tests passing.\n\n## Done\nFixed add() and reran the tests.";

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		bodies.push((await request.json()) as Record<string, unknown>);
		const stream = sse([
			{ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
			{ type: "message_stop" },
		]);
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => server.stop(true));

const model: ModelProfile = {
	ref: "test/claude-test",
	provider: "test",
	id: "claude-test",
	label: "Claude test",
	source: "config",
	api: "anthropic",
	baseUrl: `http://127.0.0.1:${server.port}`,
	context: 200_000,
	maxOutput: 16_000,
	vision: true,
	efforts: ["low", "medium", "high"],
	effortField: "none",
	replayReasoning: true,
	headers: async () => ({ "x-api-key": "test-key" }),
};

const history: Msg[] = [
	{ role: "user", content: [{ type: "text", text: "Fix the failing test." }] },
	{ role: "assistant", text: "", toolCalls: [{ id: "t1", name: "shell", args: '{"command":"pytest -q"}' }] },
	{ role: "tool", callId: "t1", name: "shell", content: "1 failed" },
	{ role: "assistant", text: "Fixed." },
];
const tools = [{ name: "shell", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } } }];

describe("anthropic adapter", () => {
	test("caches the system prompt and the growing conversation", async () => {
		for await (const _ of anthropic.stream({ model, system: "You are careful.", messages: history.slice(0, 1), tools }, new AbortController().signal));
		const body = bodies.at(-1)!;
		expect(body.cache_control).toEqual({ type: "ephemeral" });
		expect(body.system).toEqual([{ type: "text", text: "You are careful.", cache_control: { type: "ephemeral" } }]);
		expect(body.tool_choice).toBeUndefined();
	});

	test("a summary keeps the session's tools and asks for text only", async () => {
		const note = await summarize(model, history, new AbortController().signal, tools);
		expect(note).toContain("## Goal");
		const body = bodies.at(-1)!;
		expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["shell"]);
		expect(body.tool_choice).toEqual({ type: "none" });
		const last = (body.messages as { content: { text?: string }[] }[]).at(-1)!;
		expect(last.content.at(-1)!.text).toContain("Do not call any tools");
	});
});

describe("summary preparation", () => {
	test("counts what didn't fit so the note can say so", () => {
		const long: Msg[] = [];
		for (let i = 0; i < 20; i++) long.push({ role: "user", content: [{ type: "text", text: `q${i} ${"w".repeat(8_000)}` }] }, { role: "assistant", text: `a${i}` });
		const { messages, dropped } = prepareForSummary(long, 10_000);
		expect(dropped).toBeGreaterThan(0);
		expect(messages.length + dropped).toBe(long.length);
	});
});
