// Terminals for the surfaces' terminal pane. On this computer: the person's own shell in a pseudo-terminal (Bun's
// PTY, macOS and Linux). In a lab sandbox, which has no interactive shell API: a line console that runs each command
// through the sandbox and keeps track of the folder between commands.
//
// A terminal is the person's, not the agent's: it runs with their rights, like opening Terminal.app in the project.

import type { Workspace } from "./tools/workspace.ts";
import { shq } from "./sites/sandbox_workspace.ts";
import { newId } from "./util.ts";

type Emit = (name: "term.output" | "term.exit", params: { termId: string; data?: string; code?: number | null }) => void;

interface Open {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	close(): void;
}

export class Terminals {
	private open = new Map<string, Open>();

	constructor(private emit: Emit) {}

	/** Start a terminal where `workspace` acts. Returns its id and a label for the pane. */
	start(workspace: Workspace, title: string, cols: number, rows: number): { termId: string; label: string } {
		const termId = newId("t");
		// The window learns the terminal's id from this call's answer, so output from the first moments (the shell's
		// prompt, the sandbox console's banner) waits one turn of the event loop instead of going to nobody.
		let held: string[] | undefined = [];
		setTimeout(() => {
			const early = held?.join("");
			held = undefined;
			if (early) this.emit("term.output", { termId, data: early });
		}, 0);
		const output = (data: string) => (held ? held.push(data) : this.emit("term.output", { termId, data }));
		const exit = (code: number | null) => {
			this.open.delete(termId);
			const early = held?.join("");
			held = undefined;
			if (early) this.emit("term.output", { termId, data: early });
			this.emit("term.exit", { termId, code });
		};
		if (workspace.kind === "local") {
			if (process.platform === "win32") throw new Error("The terminal pane needs macOS or Linux for now; use Windows Terminal beside the app.");
			this.open.set(termId, localShell(workspace.root, cols, rows, output, exit));
			return { termId, label: process.platform === "darwin" ? "This Mac" : "This computer" };
		}
		this.open.set(termId, new SandboxConsole(workspace, title, output, exit));
		return { termId, label: title };
	}

	input(termId: string, data: string): void {
		this.open.get(termId)?.write(data);
	}

	resize(termId: string, cols: number, rows: number): void {
		this.open.get(termId)?.resize(Math.max(10, Math.min(500, cols)), Math.max(2, Math.min(300, rows)));
	}

	close(termId: string): void {
		this.open.get(termId)?.close();
		this.open.delete(termId);
	}

	closeAll(): void {
		for (const id of [...this.open.keys()]) this.close(id);
	}
}

function localShell(cwd: string, cols: number, rows: number, output: (data: string) => void, exit: (code: number | null) => void): Open {
	const decoder = new TextDecoder();
	const shell = process.env.SHELL || "/bin/bash";
	// The shell is this app's, not the terminal app that may have started the engine: without its markers, macOS
	// zsh doesn't print "Restored session" or save history per window.
	const { TERM_PROGRAM: _program, TERM_PROGRAM_VERSION: _version, TERM_SESSION_ID: _session, ...inherited } = process.env;
	const proc = Bun.spawn([shell, "-l"], {
		cwd,
		env: { ...inherited, TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "EnrichedLab", EL_TERMINAL: "1" },
		terminal: { cols, rows, data: (_terminal, data) => output(decoder.decode(data, { stream: true })) },
	});
	void proc.exited.then((code) => exit(code));
	return {
		write: (data) => proc.terminal?.write(data),
		resize: (c, r) => proc.terminal?.resize(c, r),
		close: () => proc.kill(),
	};
}

/** A line console over a sandbox's run-a-command API: echo, editing with backspace, Enter runs, Ctrl+C cancels. */
class SandboxConsole implements Open {
	private line = "";
	private cwd: string;
	private running?: AbortController;

	constructor(
		private workspace: Workspace,
		private title: string,
		private output: (data: string) => void,
		private exit: (code: number | null) => void,
	) {
		this.cwd = workspace.root;
		this.output(`\x1b[2m${title} sandbox · each line runs as one command (no network, no interactive programs)\x1b[0m\r\n`);
		this.prompt();
	}

	private prompt(): void {
		const shown = this.cwd.startsWith(this.workspace.root) ? `~${this.cwd.slice(this.workspace.root.length)}` : this.cwd;
		this.output(`\x1b[1m${this.title}\x1b[0m:${shown}$ `);
	}

	write(data: string): void {
		// Arrow keys and other escape sequences have no meaning in a line console.
		for (const ch of data.replace(/\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]/g, "")) {
			if (ch === "\x03") {
				if (this.running) this.running.abort();
				else {
					this.line = "";
					this.output("^C\r\n");
					this.prompt();
				}
			} else if (this.running) {
				// Typing while a command runs is ignored: the sandbox command has no input.
			} else if (ch === "\r" || ch === "\n") {
				this.output("\r\n");
				void this.run(this.line.trim());
				this.line = "";
			} else if (ch === "\x7f" || ch === "\b") {
				if (this.line) {
					this.line = this.line.slice(0, -1);
					this.output("\b \b");
				}
			} else if (ch === "\x04" && !this.line) {
				this.close();
			} else if (ch >= " ") {
				this.line += ch;
				this.output(ch);
			}
		}
	}

	private async run(command: string): Promise<void> {
		if (!command) return this.prompt();
		if (command === "exit") return this.close();
		this.running = new AbortController();
		const marker = `__enriched_cwd_${newId("m")}`;
		try {
			// Run in the remembered folder, then report where the command left us.
			const quoted = shq(this.cwd);
			const result = await this.workspace.exec(`cd ${quoted} && { ${command}\n}; status=$?; printf '\\n${marker}%s\\n' "$PWD"; exit $status`, {
				timeoutMs: 300_000,
				signal: this.running.signal,
			});
			// The marker line carries the folder; anything after it is stderr, which the sandbox returns separately.
			const [before, after = ""] = result.output.split(`\n${marker}`);
			const [where = "", ...rest] = after.split("\n");
			if (where.trim()) this.cwd = where.trim();
			const text = [before ?? "", rest.join("\n").trim()].filter(Boolean).join("\n");
			this.output(text.replace(/\r?\n/g, "\r\n"));
			if (text && !text.endsWith("\n")) this.output("\r\n");
			if (result.timedOut) this.output("\x1b[2m(stopped after 5 minutes; use a job for long work)\x1b[0m\r\n");
		} catch (error) {
			this.output(`\x1b[2m${(error as Error).message}\x1b[0m\r\n`);
		} finally {
			this.running = undefined;
			this.prompt();
		}
	}

	resize(): void {}

	close(): void {
		this.running?.abort();
		this.exit(0);
	}
}
