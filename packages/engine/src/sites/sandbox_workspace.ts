// A lab's sandbox as a place to work. The same file, search and shell tools that act on the person's computer act
// here through a site's sandbox API, so moving a session to a lab changes where work happens, not which tools exist.
// Commands go through the site's exec call (bash, no network); files move as base64 in small pieces or through the
// site's file upload and download for large ones.

import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { posix } from "node:path";
import type { Entry, ExecResult, Workspace } from "../tools/workspace.ts";

/** What a site's sandbox offers. Gate implements it; other lab adapters will too. */
export interface SandboxApi {
	/** The lab's display name. */
	readonly title: string;
	run(command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
	/** Copy a local file in; returns where it landed in the sandbox. */
	put(localPath: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }>;
	/** Stream a sandbox file to a local path. */
	get(path: string, target: string, signal?: AbortSignal): Promise<{ bytes: number; sha: string }>;
}

/** Quote for the sandbox's POSIX shell. */
export const shq = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const PIECE = 64 * 1024; // raw bytes per exec: base64 of it stays well under the 128 KB argument limit
const READ_PIECE = 512 * 1024;
const GLOB_SAFE = /^[\w./*?\-[\]{}@+, ]+$/;

export class SandboxWorkspace implements Workspace {
	readonly kind = "sandbox" as const;
	readonly shellName = "bash";
	readonly sandboxed = "site";
	readonly label: string;
	private ready?: Promise<void>;

	constructor(
		private api: SandboxApi,
		readonly root: string,
	) {
		this.label = `the ${api.title} sandbox, in ${root} (Linux, no network)`;
	}

	private async run(command: string, timeoutSeconds = 120, signal?: AbortSignal) {
		this.ready ??= this.api.run(`mkdir -p ${shq(this.root)}`, 30).then((r) => {
			if (r.exitCode !== 0) throw new Error(`Couldn't make ${this.root} in the ${this.api.title} sandbox: ${r.stderr || r.stdout}`);
		});
		await this.ready;
		return this.api.run(`cd ${shq(this.root)} && ${command}`, timeoutSeconds, signal);
	}

	resolve(path: string): string {
		return posix.normalize(posix.isAbsolute(path) ? path : posix.join(this.root, path));
	}

	inside(path: string): boolean {
		const full = this.resolve(path);
		return full === this.root || full.startsWith(`${this.root}/`);
	}

	display(path: string): string {
		const full = this.resolve(path);
		return full === this.root ? "." : full.startsWith(`${this.root}/`) ? full.slice(this.root.length + 1) : full;
	}

	async stat(path: string): Promise<{ type: Entry["type"]; size: number } | undefined> {
		const r = await this.run(`stat -c '%F|%s' -- ${shq(this.resolve(path))} 2>/dev/null`, 30);
		const [kind, size] = r.stdout.trim().split("|");
		if (r.exitCode !== 0 || !kind) return undefined;
		const type: Entry["type"] = kind.includes("directory") ? "dir" : kind.includes("link") ? "link" : kind.includes("regular") ? "file" : "other";
		return { type, size: Number(size) || 0 };
	}

	async list(path: string): Promise<Entry[]> {
		const r = await this.run(`find ${shq(this.resolve(path))} -mindepth 1 -maxdepth 1 -printf '%y|%s|%f\\n'`, 60);
		if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Can't list ${this.display(path)}.`);
		return r.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [y, size, ...name] = line.split("|");
				return { name: name.join("|"), type: y === "d" ? "dir" : y === "l" ? "link" : y === "f" ? "file" : "other", size: Number(size) || 0 } as Entry;
			});
	}

	async read(path: string): Promise<Buffer> {
		const full = this.resolve(path);
		const info = await this.stat(full);
		if (!info || info.type !== "file") throw new Error(`${this.display(full)} isn't a file.`);
		// Large files come through the site's download, which streams.
		if (info.size > 4 * READ_PIECE) {
			const scratch = await mkdtemp(join(tmpdir(), "enriched-read-"));
			try {
				const local = join(scratch, "file");
				await this.api.get(full, local);
				return await readFile(local);
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
		}
		const pieces: Buffer[] = [];
		for (let offset = 0; offset < Math.max(info.size, 1); offset += READ_PIECE) {
			const r = await this.run(`tail -c +${offset + 1} -- ${shq(full)} | head -c ${READ_PIECE} | base64 -w0`, 60);
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Can't read ${this.display(full)}.`);
			pieces.push(Buffer.from(r.stdout.trim(), "base64"));
		}
		return Buffer.concat(pieces);
	}

	async write(path: string, data: string | Buffer): Promise<void> {
		const full = this.resolve(path);
		const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
		const dir = shq(posix.dirname(full));
		if (bytes.length > 4 * PIECE) {
			const scratch = await mkdtemp(join(tmpdir(), "enriched-write-"));
			try {
				const local = join(scratch, `${randomBytes(4).toString("hex")}-${posix.basename(full)}`);
				await writeFile(local, bytes);
				const placed = await this.api.put(local);
				const r = await this.run(`mkdir -p ${dir} && mv -f -- ${shq(placed.path)} ${shq(full)}`, 120);
				if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Can't write ${this.display(full)}.`);
			} finally {
				await rm(scratch, { recursive: true, force: true });
			}
			return;
		}
		const temp = `${full}.${randomBytes(3).toString("hex")}.part`;
		for (let offset = 0, first = true; first || offset < bytes.length; offset += PIECE, first = false) {
			const piece = bytes.subarray(offset, offset + PIECE).toString("base64");
			const r = await this.run(`mkdir -p ${dir} && printf %s ${shq(piece)} | base64 -d ${first ? ">" : ">>"} ${shq(temp)}`, 60);
			if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `Can't write ${this.display(full)}.`);
		}
		const done = await this.run(`mv -f -- ${shq(temp)} ${shq(full)}`, 30);
		if (done.exitCode !== 0) throw new Error(done.stderr.trim() || `Can't write ${this.display(full)}.`);
	}

	async exec(command: string, options: { timeoutMs: number; signal: AbortSignal; onOutput?: (text: string) => void }): Promise<ExecResult> {
		const r = await this.run(command, Math.max(1, Math.round(options.timeoutMs / 1000)), options.signal);
		const output = [r.stdout, r.stderr].filter(Boolean).join(r.stdout && r.stderr ? "\n" : "");
		options.onOutput?.(output);
		return { exitCode: r.exitCode, output, timedOut: r.timedOut };
	}

	/** Content search with grep in the sandbox (no file-by-file round trips). */
	async grep(pattern: string, base: string, options: { glob?: string; ignoreCase?: boolean; limit: number }): Promise<string[]> {
		const include = options.glob && GLOB_SAFE.test(options.glob) ? ` --include=${shq(options.glob)}` : "";
		const r = await this.run(`grep -rnIE --exclude-dir=.git${options.ignoreCase ? " -i" : ""}${include} -e ${shq(pattern)} -- ${shq(this.display(base))} | cut -c1-500 | head -n ${options.limit * 2}`, 120);
		return r.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\.\//, ""));
	}

	/** File names matching a glob (bash globstar), relative to the project folder. */
	async glob(pattern: string, base: string): Promise<string[]> {
		if (!GLOB_SAFE.test(pattern)) throw new Error("Use a plain glob: letters, digits, / . * ? [ ] { } - _ only.");
		const r = await this.run(`cd ${shq(this.display(base))} && shopt -s globstar nullglob dotglob && for f in ${pattern}; do [ -f "$f" ] && printf '%s\\n' "$f"; done | head -n 1000`, 120);
		const prefix = base === "." ? "" : `${this.display(base)}/`;
		return r.stdout.split("\n").filter(Boolean).map((f) => prefix + f);
	}
}
