// The shared session log v1 (docs/session-log.md): engine logs go out and come back with the same model context.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../packages/protocol/src/index.ts";
import { MAX_ATTACHMENT, MAX_ATTACHMENTS, MAX_CALLS, MAX_DATA, MAX_RECORDS, fromV1, importProblem, toV1 } from "../packages/engine/src/session/log_v1.ts";
import { derive } from "../packages/engine/src/session/context.ts";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 1, 0, n)).toISOString();
const log: SessionEvent[] = [
	{ t: "header", v: 1, id: "e1", at: at(0), cwd: "/tmp/project", created: at(0), system: "You help." },
	{ t: "model", id: "e2", at: at(1), model: "lab/qwen", effort: "medium" },
	{ t: "user", id: "e3", at: at(2), text: "Count the rows", images: [{ type: "image", mime: "image/png", data: png }] },
	{ t: "assistant", id: "e4", at: at(3), model: "lab/qwen", text: "", reasoning: "Use wc.", toolCalls: [{ id: "c1", name: "shell", args: '{"command":"wc -l a.csv"}' }, { id: "c2", name: "shell", args: '{"command":"cat /etc/hosts"}' }], stop: "tool_use" },
	{ t: "tool", id: "e5", at: at(4), callId: "c1", name: "shell", ok: true, content: "3 a.csv", decision: "auto" },
	{ t: "tool", id: "e6", at: at(5), callId: "c2", name: "shell", ok: false, content: "The person declined.", decision: "denied" },
	{ t: "assistant", id: "e7", at: at(6), model: "lab/qwen", text: "Three rows.", stop: "end" },
	{ t: "title", id: "e8", at: at(7), title: "Count rows" },
	{ t: "user", id: "e9", at: at(8), text: "And the columns?" },
	{ t: "assistant", id: "e10", at: at(9), model: "lab/qwen", text: "Three columns.", stop: "end" },
	{ t: "compaction", id: "e11", at: at(10), summary: "Counted rows and columns of a.csv.", firstKeptId: "e9", tokensBefore: 900, model: "lab/qwen" },
	{ t: "notice", id: "e12", at: at(11), level: "warn", text: "Older turns were summarized." },
];

const shape = (events: SessionEvent[]) => derive(events).messages.map((m) => JSON.stringify(m));

describe("session log v1", () => {
	test("export: gap-free seq, decisions apart from results, images by reference", () => {
		const { events, attachments } = toV1(log);
		expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
		expect(events.every((e) => e.v === 1)).toBe(true);
		const kinds = events.map((e) => e.kind);
		expect(kinds.filter((k) => k === "decision")).toHaveLength(2);
		expect(kinds.filter((k) => k === "tool_result")).toHaveLength(2);
		const denied = events.find((e) => e.kind === "decision" && e.data.callId === "c2")!;
		expect(denied.data).toMatchObject({ verdict: "deny", by: "person" });
		const user = events.find((e) => e.kind === "user")!;
		const ref = (user.data.images as { sha256: string; uri: string }[])[0]!;
		expect(JSON.stringify(events)).not.toContain(png);
		expect(attachments[ref.sha256]?.data).toBe(png);
		const compaction = events.find((e) => e.kind === "compaction")!;
		// It covers everything up to the last event before "And the columns?".
		const firstKept = events.find((e) => e.kind === "user" && e.data.text === "And the columns?")!;
		expect(compaction.data.through).toBe(firstKept.seq - 1);
		expect(kinds).toContain("x-header");
	});

	test("import rebuilds the same context", () => {
		const { events, attachments } = toV1(log);
		const back = fromV1(events, attachments);
		expect(back.cwd).toBe("/tmp/project");
		expect(shape(back.events)).toEqual(shape(log.slice(1)));
	});

	test("orphan results are dropped, unanswered calls get the stand-in, unknown kinds are skipped", () => {
		const v1 = [
			{ v: 1 as const, seq: 1, time: at(0), kind: "user", data: { text: "Go" } },
			{ v: 1 as const, seq: 2, time: at(1), kind: "assistant", data: { text: "", calls: [{ id: "k1", name: "read", arguments: { path: "x" } }], stop: "tool_use" } },
			{ v: 1 as const, seq: 3, time: at(2), kind: "tool_result", data: { callId: "nope", tool: "read", output: "stray" } },
			{ v: 1 as const, seq: 4, time: at(3), kind: "rein-hold", data: { holdId: "h1" } },
			{ v: 1 as const, seq: 5, time: at(4), kind: "user", data: { text: "Stopped?" } },
		];
		const { events } = fromV1(v1);
		const tools = events.filter((e) => e.t === "tool");
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ callId: "k1", ok: false, content: "The read call never finished (the run was stopped)." });
		expect(JSON.stringify(events)).not.toContain("stray");
		expect(events.find((e) => e.t === "assistant")).toMatchObject({ toolCalls: [{ id: "k1", args: '{"path":"x"}' }] });
	});

	test("export meets the import limits: unique call ids per turn, at most 64 calls, compaction through never goes back", () => {
		const calls = Array.from({ length: MAX_CALLS + 3 }, (_, n) => ({ id: n < 2 ? "dup" : `c${n}`, name: "read", args: "{}" }));
		const events: SessionEvent[] = [
			{ t: "header", v: 1, id: "h", at: at(0), cwd: "/tmp/p", created: at(0), system: "" },
			{ t: "user", id: "u1", at: at(1), text: "read them all" },
			{ t: "assistant", id: "a1", at: at(2), model: "m", text: "", toolCalls: calls, stop: "tool_use" },
			...calls.map((c, n) => ({ t: "tool" as const, id: `r${n}`, at: at(3), callId: c.id, name: "read", ok: true, content: `out ${n}`, decision: "auto" as const })),
			{ t: "assistant", id: "a2", at: at(4), model: "m", text: "done", stop: "end" as const },
			{ t: "compaction", id: "k1", at: at(5), summary: "later", firstKeptId: "a2", tokensBefore: 1, model: "m" },
			{ t: "compaction", id: "k2", at: at(6), summary: "earlier point", firstKeptId: "u1", tokensBefore: 1, model: "m" },
		];
		const out = toV1(events).events;
		const turn = out.find((e) => e.kind === "assistant" && (e.data.calls as unknown[]).length)!;
		const ids = (turn.data.calls as { id: string }[]).map((c) => c.id);
		expect(ids).toHaveLength(MAX_CALLS);
		expect(new Set(ids).size).toBe(ids.length);
		// Each result keeps its own call, in order, and results for calls left out go too.
		const results = out.filter((e) => e.kind === "tool_result");
		expect(results.map((r) => r.data.callId)).toEqual(ids);
		expect(results[1]!.data.output).toBe("out 1");
		expect(out.some((e) => e.kind === "notice" && String(e.data.text).includes("3 more tool calls"))).toBe(true);
		const compactions = out.filter((e) => e.kind === "compaction");
		for (const c of compactions) expect(Number(c.data.through)).toBeLessThan(c.seq);
		expect(Number(compactions[1]!.data.through)).toBeGreaterThanOrEqual(Number(compactions[0]!.data.through));
	});

	test("a session longer than the record limit exports its newest turns behind a summary, and imports", () => {
		const events: SessionEvent[] = [{ t: "header", v: 1, id: "h", at: at(0), cwd: "/tmp/p", created: at(0), system: "" }];
		for (let n = 0; n < 10_500; n++) {
			events.push({ t: "user", id: `u${n}`, at: at(1), text: `question ${n}` });
			events.push({ t: "assistant", id: `a${n}`, at: at(2), model: "m", text: `answer ${n}`, stop: "end" });
			if (n === 9_000) events.push({ t: "compaction", id: "k", at: at(3), summary: "Questions up to 8,990.", firstKeptId: "u8990", tokensBefore: 1, model: "m" });
		}
		const out = toV1(events).events;
		expect(out.length).toBeLessThanOrEqual(MAX_RECORDS);
		expect(out.map((e) => e.seq)).toEqual(out.map((_, i) => i + 1));
		expect(out[0]!.kind).toBe("compaction");
		expect(String(out[0]!.data.summary)).toContain("left out of the export");
		expect(out[1]!.kind).toBe("user");
		for (const c of out.filter((e) => e.kind === "compaction")) expect(Number(c.data.through)).toBeLessThan(c.seq);
		// The newest turn is there, and the engine reads the export back.
		expect(out.at(-1)!.data.text).toBe("answer 10499");
		const back = fromV1(out);
		expect(back.events.some((e) => e.t === "compaction")).toBe(true);
		expect(back.events.filter((e) => e.t === "user").at(-1)).toMatchObject({ text: "question 10499" });
	});

	test("no event's data is over the size limit: large arguments become {} and long text is cut", () => {
		const big = "x".repeat(300 * 1024);
		const out = toV1([
			{ t: "header", v: 1, id: "h", at: at(0), cwd: "/tmp/p", created: at(0), system: "" },
			{ t: "user", id: "u", at: at(1), text: "write it" },
			{ t: "assistant", id: "a", at: at(2), model: "m", text: "", toolCalls: [{ id: "c", name: "write", args: JSON.stringify({ content: big }) }], stop: "tool_use" },
			{ t: "tool", id: "r", at: at(3), callId: "c", name: "write", ok: true, content: big, decision: "auto" },
		]).events;
		for (const e of out) expect(Buffer.byteLength(JSON.stringify(e.data))).toBeLessThanOrEqual(MAX_DATA);
		expect((out.find((e) => e.kind === "assistant")!.data.calls as { arguments: unknown }[])[0]!.arguments).toEqual({});
		expect(String(out.find((e) => e.kind === "tool_result")!.data.output)).toEndWith("[cut to fit the shared log]");
	});
});

describe("session log v1 import from someone else", () => {
	test("records about the writer's computer are skipped: an imported checkpoint can't steer Undo", () => {
		const v1 = [
			{ v: 1 as const, seq: 1, time: at(0), kind: "user", data: { text: "Hi" } },
			{ v: 1 as const, seq: 2, time: at(1), kind: "assistant", data: { text: "Hello.", stop: "end" } },
			{ v: 1 as const, seq: 3, time: at(2), kind: "x-checkpoint", data: { commit: "abc", files: [{ path: "/Users/someone/.ssh/id_ed25519", existed: false }] } },
			{ v: 1 as const, seq: 4, time: at(3), kind: "x-place", data: { place: "lab", label: "a sandbox", root: "/sandbox/work/x" } },
			{ v: 1 as const, seq: 5, time: at(4), kind: "x-undo", data: { checkpoint: "e1" } },
			{ v: 1 as const, seq: 6, time: at(5), kind: "x-local", data: { anything: true } },
			{ v: 1 as const, seq: 7, time: at(6), kind: "x-title", data: { title: "Greeting" } },
		];
		const kinds = fromV1(v1).events.map((e) => e.t);
		expect(kinds).toEqual(["user", "assistant", "title"]);
	});

	test("an import over the shared log's limits is refused before it's read", () => {
		const record = (seq: number, data: Record<string, unknown> = {}) => ({ v: 1 as const, seq, time: at(0), kind: "notice", data });
		expect(importProblem([record(1)], {})).toBeUndefined();
		expect(importProblem(Array.from({ length: MAX_RECORDS + 1 }, (_, i) => record(i + 1)), {})).toContain("records");
		expect(importProblem([record(1, { text: "x".repeat(MAX_DATA + 8192) })], {})).toContain("252 KiB");
		expect(importProblem([], { a: { mime: "image/png", data: "x".repeat(MAX_ATTACHMENT + 1) } })).toContain("16 MB");
		const many = Object.fromEntries(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => [`k${i}`, { mime: "image/png", data: "x" }]));
		expect(importProblem([], many)).toContain("images");
	});
});
