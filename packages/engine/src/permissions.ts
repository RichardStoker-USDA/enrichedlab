// Which tool calls run, which ask, and how an answer is remembered for the rest of a session. This guards against a
// model steered by text it read; it is not an OS sandbox. What runs without asking only reads inside the project:
// anything that reads outside it, writes, runs a program or reaches a new host asks first.

import type { LabConfig } from "./config.ts";
import { isReadOnlyCommand, pathsInside } from "./tools/shell.ts";
import type { Tool } from "./tools/types.ts";
import { isOpenPort } from "./sites/port_proxy.ts";
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

/** Tools that change files in the project. Other writes (browser actions, apps, memory, PDF forms) are each their own. */
const FILE_EDITS = new Set(["write", "edit"]);

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
	if (tool.kind === "write") return FILE_EDITS.has(tool.name) ? "write" : `write:${tool.name}`;
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

/** An IPv4 address in loopback, private, carrier NAT (Tailscale's range too), link-local and metadata, or "this network". */
function localV4(a: number, b: number): boolean {
	return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** An IPv6 address as eight 16-bit groups, or undefined when it isn't one. Takes a dotted IPv4 tail too. */
function v6Groups(text: string): number[] | undefined {
	if (!text.includes(":") || !/^[0-9a-f:.]+$/i.test(text)) return undefined;
	let address = text;
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
		address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = address.split("::");
	if (halves.length > 2) return undefined;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
	const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
	return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : undefined;
}

/**
 * Loopback, private, carrier NAT, link-local and cloud metadata addresses get a sharper question, in IPv6 too: ULA,
 * link-local, and the mapped, NAT64 and 6to4 forms that carry an IPv4 address.
 */
function localHost(name: string): boolean {
	const h = (name.startsWith("[") ? name.slice(1, name.indexOf("]")) : name.replace(/:\d+$/, "")).toLowerCase().replace(/\.$/, "");
	if (/^(localhost|.+\.(localhost|local|internal|lan|home\.arpa))$/.test(h)) return true;
	const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
	if (v4) return localV4(Number(v4[1]), Number(v4[2]));
	const g = v6Groups(h);
	if (!g) return false;
	const embedded = (hi: number) => localV4(hi >> 8, hi & 0xff);
	if (g.slice(0, 7).every((x) => x === 0)) return g[7]! <= 1; // :: and ::1
	if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return embedded(g[6]!); // ::ffff:a.b.c.d
	if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!); // NAT64
	if (g[0] === 0x2002) return embedded(g[1]!); // 6to4
	return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80; // ULA, link-local
}

/** The question a push asks; headless runs refuse it unless the person passed --push. */
export const PUSH_REASON = "It pushes to a remote.";

export function decide(tool: Tool, args: Record<string, unknown>, workspace: Workspace, config: LabConfig, allowed: Set<string>): Verdict {
	const mode = config.permissions.mode;
	const extra = tool.ask?.(args, { workspace });
	const key = allowKey(tool, args);
	// Pushing publishes work, and an unreviewed lab tool hasn't been checked by anyone: both ask in every mode, every time.
	if (key === "shell!push") return { action: "ask", reason: PUSH_REASON, key };
	if (tool.unreviewed) return { action: "ask", reason: "The lab hasn't reviewed this tool yet, so it asks every time.", key: `unreviewed!${tool.name}` };
	if (mode === "full") return { action: "run" };
	// An answer about something outside the project is remembered for that path only; "!" keys never are.
	const outside = `${key}:outside:${String(args.path ?? args.url ?? "")}`;
	if (!key.includes("!") && allowed.has(extra ? outside : key)) return { action: "run" };
	switch (tool.kind) {
		case "net": {
			// The engine's own ports show the person's sandbox apps; nothing goes anywhere the person didn't send it.
			if (typeof args.url === "string" && isOpenPort(args.url)) return { action: "run" };
			if (extra) return { action: "ask", reason: extra, key: outside };
			const name = tool.host?.(args) ?? host(args);
			const reason = localHost(name) ? `It reaches ${name}, an address on this computer or your network.` : `It sends a request to ${name}.`;
			return { action: "ask", reason, key };
		}
		case "read":
		case "local":
		case "site-read":
		case "sandbox":
			return extra ? { action: "ask", reason: extra, key: outside } : { action: "run" };
		case "write":
			if (extra) return { action: "ask", reason: extra, key: outside };
			// File edits in a session's own worktree go to its own branch, and work in a lab's sandbox comes home as a
			// branch: the person reviews them when they merge. Other writes (a click in the browser, a new app) ask in every
			// mode until allowed.
			if (key === "write" && (mode === "edits" || ownWorktree(workspace) || workspace.sandboxed === "site")) return { action: "run" };
			return { action: "ask", reason: key === "write" ? "It changes a file." : `It ${WRITES[tool.name] ?? (tool.name.endsWith("_sandbox_download") ? "copies a file from the sandbox into the project" : "changes something")}.`, key };
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

/** What a write that isn't a file edit does, for its question. */
const WRITES: Record<string, string> = {
	browser_click: "clicks in the browser, where you may be signed in",
	browser_type: "types into a page in the browser, where you may be signed in",
	app_create: "makes an app in the project",
	remember: "saves a note to memory that later sessions read",
	skill_create: "saves a skill that later sessions use",
	pdf_fill: "fills in a PDF form",
};

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
