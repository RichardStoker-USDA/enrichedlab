// Hooks: the person's own commands around tool calls, configured in config.json:
//
//   "hooks": { "beforeTool": [{ "match": "shell|write|edit", "command": "~/bin/check.sh" }],
//              "afterTool":  [{ "match": "edit", "command": "npx prettier --write \"$ENRICHED_PATH\"" }] }
//
// A hook gets the call as JSON on stdin and ENRICHED_TOOL / ENRICHED_PATH in its environment, and runs in the project folder.
// Before a call, exit code 2 blocks it and stderr tells the model why. After a call, stdout is added to the result.
// The same contract as Claude Code hooks, so existing scripts carry over.

import { spawn } from "node:child_process";
import { expandHome } from "./util.ts";

export interface HookConfig {
	/** A regular expression over the tool name. */
	match?: string;
	command: string;
	/** Seconds; default 30. */
	timeout?: number;
}

export interface Hooks {
	beforeTool?: HookConfig[];
	afterTool?: HookConfig[];
}

export interface HookOutcome {
	blocked?: string;
	note?: string;
}

export async function runHooks(list: HookConfig[] | undefined, call: { tool: string; args: Record<string, unknown>; result?: unknown }, cwd: string): Promise<HookOutcome> {
	const outcome: HookOutcome = {};
	for (const hook of list ?? []) {
		if (hook.match && !new RegExp(`^(${hook.match})$`).test(call.tool)) continue;
		const { code, stdout, stderr } = await run(hook, call, cwd);
		if (code === 2) return { blocked: stderr.trim() || `A hook (${hook.command}) blocked this call.` };
		if (stdout.trim()) outcome.note = [outcome.note, stdout.trim()].filter(Boolean).join("\n");
	}
	return outcome;
}

function run(hook: HookConfig, call: { tool: string; args: Record<string, unknown> }, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((done) => {
		const child = spawn(expandHome(hook.command), {
			cwd,
			shell: true,
			env: { ...process.env, ENRICHED_TOOL: call.tool, ENRICHED_PATH: String(call.args.path ?? call.args.to ?? "") },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			timeout: (hook.timeout ?? 30) * 1_000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
		child.on("error", (error) => done({ code: 1, stdout, stderr: error.message }));
		child.on("close", (code) => done({ code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 4_000) }));
		// A hook may exit without reading the call (exit 2 at once); the closed pipe is not an error.
		child.stdin.on("error", () => undefined);
		child.stdin.end(JSON.stringify(call));
	});
}
