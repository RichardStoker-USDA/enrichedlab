// A subagent's question reaches the windows showing its lead session (where the person is) and any showing the
// subagent itself, names the lead, and is settled in both places (packages/engine/src/engine.ts ask()).

import { expect, test } from "bun:test";
import type { PermissionDecision, PermissionRequest } from "../packages/protocol/src/index.ts";
import { Engine } from "../packages/engine/src/engine.ts";

type Emitted = { name: string; params: unknown; scope?: string };

function engineWith(parents: Record<string, string | undefined>) {
	const emitted: Emitted[] = [];
	const proto = Engine.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const self = {
		options: {},
		waiting: new Map<string, { request: PermissionRequest; resolve: (d: PermissionDecision | "cancelled") => void }>(),
		sessions: new Map(Object.entries(parents).map(([id, parent]) => [id, { parent }])),
		emit: (name: string, params: unknown, scope?: string) => emitted.push({ name, params, scope }),
		leadOf: proto.leadOf,
	};
	const ask = (request: PermissionRequest) => proto.ask!.call(self, request, new AbortController().signal) as Promise<PermissionDecision | "cancelled">;
	return { self, emitted, ask };
}

const request = (sessionId: string): PermissionRequest => ({ requestId: `r-${sessionId}`, sessionId, callId: "c1", tool: "write", view: { verb: "write", target: "a.txt" }, reason: "It changes a file." });

test("a subagent's question goes to its lead's windows and its own, and names the lead", async () => {
	const { self, emitted, ask } = engineWith({ lead: undefined, child: "lead" });
	const answer = ask(request("child"));
	const asked = emitted.filter((e) => e.name === "permission.request");
	expect(asked.map((e) => e.scope)).toEqual(["lead", "child"]);
	expect((asked[0]!.params as PermissionRequest).lead).toBe("lead");
	self.waiting.get("r-child")!.resolve("allow");
	expect(await answer).toBe("allow");
	expect(emitted.filter((e) => e.name === "permission.settled").map((e) => e.scope)).toEqual(["lead", "child"]);
});

test("a session's own question goes only to its windows, with no lead", async () => {
	const { self, emitted, ask } = engineWith({ solo: undefined });
	const answer = ask(request("solo"));
	const asked = emitted.filter((e) => e.name === "permission.request");
	expect(asked.map((e) => e.scope)).toEqual(["solo"]);
	expect((asked[0]!.params as PermissionRequest).lead).toBeUndefined();
	self.waiting.get("r-solo")!.resolve("deny");
	expect(await answer).toBe("deny");
});

test("the lead is found when the lead session isn't loaded", async () => {
	const { emitted, ask } = engineWith({ child: "lead-on-disk" });
	void ask(request("child"));
	expect(emitted.filter((e) => e.name === "permission.request").map((e) => e.scope)).toEqual(["lead-on-disk", "child"]);
});
