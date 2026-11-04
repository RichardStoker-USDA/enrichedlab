// Subagents: the model hands a bounded task to a child session and keeps working. agent_start returns at once;
// agent_wait collects results when the lead needs them. A child works in the same folder with the same site binding,
// can't start agents of its own, and by default only reads: anything that would ask is refused, so a child never
// leaves the person an approval they can't see.

import { num, str, type Tool, ToolError } from "./types.ts";

export interface AgentResult {
	agent: string;
	state: "running" | "done" | "failed" | "cancelled";
	/** The child's final answer, or what it said last. */
	answer: string;
}

/** What a session offers its tools for starting and collecting child sessions. */
export interface AgentHost {
	start(task: string, options: { mode: "read" | "full"; model?: string }): string;
	wait(agents: string[], timeoutMs: number, signal: AbortSignal): Promise<AgentResult[]>;
}

const MAX_WAIT_S = 1_800;

export const agentStartTool: Tool = {
	name: "agent_start",
	kind: "local",
	description:
		"Start a subagent on a bounded task and keep working; collect its answer later with agent_wait. Give it everything it needs in the task: it doesn't see this conversation. By default it can read, search and run read-only commands; mode \"full\" lets it change files too (it asks the person the same way you do). Use several for independent parts of a job.",
	parameters: {
		type: "object",
		properties: {
			task: { type: "string", description: "The whole task and what to report back." },
			mode: { type: "string", enum: ["read", "full"] },
			model: { type: "string", description: "A model reference; defaults to this session's model." },
		},
		required: ["task"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "agent", target: String(a.task ?? "").split("\n")[0] ?? "" }),
	async run(args, ctx) {
		if (!ctx.agents) throw new ToolError("Subagents can't start agents of their own.");
		const mode = args.mode === "full" ? "full" : "read";
		const agent = ctx.agents.start(str(args, "task"), { mode, model: typeof args.model === "string" ? args.model : undefined });
		return { ok: true, content: `Started ${agent} (${mode}). Collect its answer with agent_wait.`, view: { result: "started", session: agent } };
	},
};

export const agentWaitTool: Tool = {
	name: "agent_wait",
	kind: "local",
	description: "Wait for subagents and return their answers. Returns early with the ones still running when the timeout passes (default 600 seconds; 0 just checks).",
	parameters: {
		type: "object",
		properties: { agents: { type: "array", items: { type: "string" } }, timeout: { type: "integer" } },
		required: ["agents"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "wait", target: Array.isArray(a.agents) ? a.agents.join(", ") : "" }),
	async run(args, ctx) {
		if (!ctx.agents) throw new ToolError("Subagents can't wait on agents.");
		const agents = Array.isArray(args.agents) ? args.agents.map(String) : [];
		if (!agents.length) throw new ToolError("Name at least one agent.");
		const timeout = Math.min(MAX_WAIT_S, Math.max(0, num(args, "timeout") ?? 600));
		const results = await ctx.agents.wait(agents, timeout * 1_000, ctx.signal);
		const done = results.filter((r) => r.state !== "running").length;
		return {
			ok: results.every((r) => r.state === "done"),
			content: results.map((r) => `## ${r.agent} (${r.state})\n\n${r.answer || "(no answer yet)"}`).join("\n\n"),
			view: { result: `${done} of ${results.length} finished` },
		};
	},
};
