// Which tool calls run, which ask, and how an answer is remembered for the rest of a session. This guards against a
// model steered by text it read; it is not an OS sandbox. What runs without asking only reads inside the project:
// anything that reads outside it, writes, runs a program or reaches a new host asks first.

import type { LabConfig } from "./config.ts";
import { isReadOnlyCommand, pathsInside } from "./tools/shell.ts";
import type { Tool } from "./tools/types.ts";
import { FULL_CONTAINMENT } from "./tools/workspace.ts";
import type { Workspace } from "./tools/workspace.ts";

export type Verdict = { action: "run" } | { action: "ask"; reason: string; key: string };

/** Programs that run whatever they are given: allowing one for the session allows only that exact command. */
const RUNS_ANYTHING = new Set([
	"python", "python3", "node", "bun", "deno", "ruby", "perl", "php", "bash", "sh", "zsh", "fish", "pwsh", "powershell",
	"env", "xargs", "sudo", "doas", "eval", "exec", "nohup", "time", "timeout", "watch", "ssh", "osascript", "open", "start",
	"cmd", "Invoke-Expression", "iex",
]);
/** Tools whose first argument names the action: keyed by both words, so "git status" doesn't allow "git push". */
const SUBCOMMANDS = new Set([
	"git", "npm", "pnpm", "yarn", "npx", "bunx", "cargo", "go", "pixi", "uv", "pip", "pip3", "docker", "podman", "kubectl", "helm",
	"make", "just", "brew", "gh", "terraform", "dotnet", "swift", "mvn", "gradle",
]);

/** The key an "allow for this session" answer is stored under. */
export function allowKey(tool: Tool, args: Record<string, unknown>): string {
	if (tool.kind === "exec") {
		const command = String(args.command ?? "").trim();
		const words = command.split(/\s+/);
		const first = words[0] ?? "";
		// Pushing publishes work: it asks every time, whatever was allowed before.
		if (/(^|[;&|\n]\s*)git\s+(\S+\s+)*push\b/.test(command)) return "shell!push";
		if (/[;&|<>`$\n]/.test(command) || RUNS_ANYTHING.has(first) || /^\w+=/.test(first)) return `shell=${command}`;
		if (SUBCOMMANDS.has(first) && words[1] && !words[1].startsWith("-")) return `shell:${first} ${words[1]}`;
		return `shell:${first}`;
	}
	if (tool.kind === "write") return "write";
	if (tool.kind === "net") return `net:${tool.host?.(args) ?? host(args)}`;
	return `tool:${tool.name}`;
}

function host(args: Record<string, unknown>): string {
	try {
		return new URL(String(args.url ?? "")).host.toLowerCase();
	} catch {
		return "?";
	}
}

/** Loopback, private, link-local and cloud metadata addresses get a sharper question. */
function localHost(name: string): boolean {
	const h = name.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
	return /^(localhost|.*\.local|.*\.internal|.*\.lan|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|::1$|fc|fd|fe80:)/i.test(h);
}

/** The question a push asks; headless runs refuse it unless the person passed --push. */
export const PUSH_REASON = "It pushes to a remote.";

export function decide(tool: Tool, args: Record<string, unknown>, workspace: Workspace, config: LabConfig, allowed: Set<string>): Verdict {
	const mode = config.permissions.mode;
	const extra = tool.ask?.(args, { workspace });
	const key = allowKey(tool, args);
	// Pushing publishes work: it asks in every mode, every time.
	if (key === "shell!push") return { action: "ask", reason: PUSH_REASON, key };
	if (mode === "full") return { action: "run" };
	// An answer about something outside the project is remembered under its own key.
	if (!key.startsWith("shell!") && allowed.has(extra ? `${key}:outside` : key)) return { action: "run" };
	switch (tool.kind) {
		case "net": {
			if (extra) return { action: "ask", reason: extra, key: `${key}:outside` };
			const name = tool.host?.(args) ?? host(args);
			const reason = localHost(name) ? `It reaches ${name}, an address on this computer or your network.` : `It sends a request to ${name}.`;
			return { action: "ask", reason, key };
		}
		case "read":
		case "local":
		case "site-read":
		case "sandbox":
			return extra ? { action: "ask", reason: extra, key: `${key}:outside` } : { action: "run" };
		case "write":
			if (extra) return { action: "ask", reason: extra, key: `${key}:outside` };
			// A session's own worktree is its own branch: the person reviews the work when they merge it.
			return mode === "edits" || ownWorktree(workspace) ? { action: "run" } : { action: "ask", reason: "It changes a file.", key };
		case "exec": {
			const command = String(args.command ?? "");
			// In its own worktree the agent commits to its own branch; the person merges it.
			if (ownBranchCommit(command, workspace)) return { action: "run" };
			// Contained by the OS: writes stay in the project and temp folders, no network. Runs without asking unless it
			// names a path outside the project or expands variables (the sandbox can still read most of the disk).
			// Contained commands that stay inside the project run; Windows contains writes only, so it still asks.
			if (workspace.sandboxed && FULL_CONTAINMENT.has(workspace.sandboxed) && args.unsandboxed !== true && pathsInside(command, (path) => workspace.inside(path))) return { action: "run" };
			if (isReadOnlyCommand(command, config.permissions.allowCommands, (path) => workspace.inside(path))) return { action: "run" };
			const reads = isReadOnlyCommand(command, config.permissions.allowCommands, () => true);
			return { action: "ask", reason: reads ? "It reads outside the project folder." : "It runs a command that can change things.", key };
		}
		case "site-write":
			return { action: "ask", reason: "The site doesn't mark this tool read-only.", key };
	}
}

/** True when the session works in a worktree EnrichedLab made for it. */
function ownWorktree(workspace: Workspace): boolean {
	return /[/\\]\.git[/\\]enrichedlab-worktrees[/\\]/.test(workspace.root);
}

/** `git add` and `git commit` (alone or joined with &&) inside a worktree EnrichedLab made for this session. */
function ownBranchCommit(command: string, workspace: Workspace): boolean {
	if (!ownWorktree(workspace)) return false;
	const parts = command.split("&&").map((part) => part.trim());
	return parts.every((part) => /^git\s+(add|commit|status|diff|log)\b/.test(part) && !/[;|<>`$\n&]/.test(part) && !/\s--(amend|no-verify)\b/.test(part) && pathsInside(part, (path) => workspace.inside(path)));
}
