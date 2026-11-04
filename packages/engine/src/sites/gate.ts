// The Gate adapter: everything a person may use on a Gate site, read from Gate itself.
//
//   GET /v1/me          who they are, quotas, whether files and sandboxes are on
//   GET /v1/models      the models they may use, with context, output cap, reasoning levels and where levels go
//   POST /mcp           the tools their role grants (MCP, Streamable HTTP)
//   /v1/containers      their sandbox: run, background jobs, copy files in and out

import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { BundleGrant } from "../bundles.ts";
import { repoRoot } from "../git.ts";
import { connectRemote, type McpConnection } from "../mcp.ts";
import { labFetch } from "../models/http.ts";
import type { ModelProfile } from "../models/types.ts";
import { num, str, type Tool, ToolError } from "../tools/types.ts";
import { errorText, redact, SECRET_NAME } from "../util.ts";
import type { SiteAdapter } from "./adapter.ts";
import { fetchRepo, sendRepo } from "./repo_handoff.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import type { SiteConfig, SiteRoute } from "./sites.ts";

interface GateModel {
	id: string;
	max_model_len?: number;
	gate?: {
		aliases?: string[];
		capabilities?: string[];
		context?: number;
		default_effort?: string;
		effort_field?: string;
		efforts?: string[];
		endpoints?: string[];
		max_output?: number;
	};
}

interface GateMe {
	handle?: string;
	owner?: boolean;
	files?: { enabled?: boolean };
	sandboxes?: { enabled?: boolean; idle_minutes?: number };
	quotas?: unknown[];
}

export class GateSite implements SiteAdapter, SandboxApi {
	who?: string;
	owner = false;
	models: ModelProfile[] = [];
	tools: Tool[] = [];
	sandboxOn = false;
	warning?: string;
	private mcp?: McpConnection;
	private container?: string;
	private starting?: Promise<string>;
	/** Background jobs started in the sandbox, so shutdown never deletes a sandbox while one runs. */
	private jobs = new Set<string>();
	/** Repositories sent to the sandbox from this engine: sandbox folder → local repository and the commit sent. */
	private sent = new Map<string, { repo: string; base: string }>();

	constructor(
		readonly config: SiteConfig,
		readonly route: SiteRoute,
		/** The sandbox an earlier connection to this site made; a reconnect keeps using it. */
		container?: string,
	) {
		this.container = container;
	}

	private async call(method: string, path: string, init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
		const headers: Record<string, string> = { accept: "application/json", ...init.headers, ...(await this.route.headers()) };
		let body = init.body;
		if (init.json !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.json);
		}
		const streamed = typeof ReadableStream !== "undefined" && body instanceof ReadableStream;
		const response = await labFetch(`${this.route.base}${path}`, {
			method,
			headers,
			body,
			signal: init.signal,
			ca: this.route.ca,
			redirect: "manual",
			...(streamed ? { duplex: "half" } : {}),
		} as RequestInit & { ca?: string });
		if (response.status >= 300 && response.status < 400) throw new Error(`${this.config.name} asked for a sign-in. Run el login ${this.config.name}.`);
		if (!response.ok) {
			const challenge = response.headers.get("www-authenticate") ?? "";
			if (response.status === 401 && this.route.via === "oauth" && /invalid_token/.test(challenge)) {
				// Cloudflare Access itself refused the token, before the request reached the site. Signing in again
				// gets another token Access will refuse the same way, so say what has to change instead.
				throw new Error(`Cloudflare Access refused the sign-in token for ${this.config.name} (invalid_token). The site's Access application has to accept OAuth tokens (its binding cookie off); signing in again won't change it.`);
			}
			const detail = ((await response.json().catch(() => undefined)) ?? {}) as { error?: { message?: string } };
			const message = detail.error?.message ?? `${this.config.name} answered ${response.status}.`;
			const error = new Error(response.status === 401 ? `${message.replace(/\.$/, "")}. Run el login ${this.config.name}.` : message);
			throw Object.assign(error, { status: response.status });
		}
		return response;
	}

	private async json<T>(method: string, path: string, init: Parameters<GateSite["call"]>[2] = {}): Promise<T> {
		return (await (await this.call(method, path, init)).json()) as T;
	}

	async connect(): Promise<void> {
		const me = await this.json<GateMe>("GET", "/v1/me", { signal: AbortSignal.timeout(10_000) });
		this.who = me.handle;
		this.owner = me.owner === true;
		this.sandboxOn = me.sandboxes?.enabled === true;
		const list = await this.json<{ data?: GateModel[] }>("GET", "/v1/models", { signal: AbortSignal.timeout(10_000) });
		this.models = (list.data ?? []).filter((m) => !m.gate?.endpoints?.length || m.gate.endpoints.includes("chat")).map((m) => this.profile(m));
		const tools: Tool[] = [];
		try {
			this.mcp = await connectRemote(this.config.name, { url: `${this.route.base}/mcp`, headers: () => this.route.headers(), ca: this.route.ca, origin: "site" });
			tools.push(...this.mcp.tools);
		} catch (error) {
			this.warning = `Tools unavailable: ${redact(errorText(error))}`;
		}
		if (this.sandboxOn) tools.push(...this.sandboxTools());
		this.tools = tools;
	}

	get title(): string {
		return this.config.title ?? this.config.name;
	}

	sandboxApi(): SandboxApi | undefined {
		return this.sandboxOn ? this : undefined;
	}

	/** Bundles this person's role is granted, from GET /v1/bundles. A Gate that doesn't serve it grants none. */
	async bundles(): Promise<BundleGrant[]> {
		try {
			const list = await this.json<{ data?: BundleGrant[] }>("GET", "/v1/bundles", { signal: AbortSignal.timeout(10_000) });
			return list.data ?? [];
		} catch (error) {
			if ((error as { status?: number }).status === 404) return [];
			throw error;
		}
	}

	describe(): string {
		const parts = [`${this.config.name} (${this.config.url}) as ${this.who ?? "unknown"}`];
		if (this.models.length) parts.push(`models ${this.models.map((m) => m.id).join(", ")}`);
		if (this.sandboxOn) parts.push(`an isolated Linux sandbox with no network (tools ${this.config.name}_sandbox_*)`);
		if (this.mcp?.tools.length) parts.push(`${this.mcp.tools.length} site tools`);
		return parts.join("; ");
	}

	private profile(m: GateModel): ModelProfile {
		const g = m.gate ?? {};
		const capabilities = g.capabilities ?? [];
		const reasoning = capabilities.includes("reasoning");
		const template = g.effort_field === "chat_template_kwargs";
		const efforts = reasoning ? [...(template ? ["off"] : []), ...(g.efforts?.length ? g.efforts : ["low", "medium", "high"])] : [];
		const name = this.config.name;
		return {
			ref: `${name}/${m.id}`,
			provider: name,
			id: m.id,
			label: `${m.id} · ${name}`,
			source: "site",
			api: "openai-chat",
			baseUrl: `${this.route.base}/v1`,
			context: g.context ?? m.max_model_len ?? 131_072,
			maxOutput: g.max_output ?? 8_192,
			vision: capabilities.includes("vision"),
			efforts,
			defaultEffort: reasoning ? g.default_effort : undefined,
			effortField: reasoning ? (template ? "chat_template_kwargs" : "reasoning_effort") : "none",
			replayReasoning: reasoning,
			headers: () => this.route.headers(),
			ca: this.route.ca,
		};
	}

	// ── Sandbox ────────────────────────────────────────────────────────────────────────────────────────────────────

	private async sandbox(signal?: AbortSignal): Promise<string> {
		if (this.container) {
			try {
				const current = await this.json<{ status?: string }>("GET", `/v1/containers/${this.container}`, { signal });
				if (current.status !== "expired" && current.status !== "deleted") return this.container;
			} catch {
				// Gone; make a new one.
			}
			this.container = undefined;
		}
		this.starting ??= this.json<{ id: string }>("POST", "/v1/containers", { json: { name: "EnrichedLab" }, signal: AbortSignal.timeout(300_000) })
			.then((made) => {
				this.container = made.id;
				return made.id;
			})
			.finally(() => {
				this.starting = undefined;
			});
		return this.starting;
	}

	/** Run a command in the sandbox: its exit code and output streams. */
	async run(command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
		const id = await this.sandbox(signal);
		const result = await this.json<{ exit_code?: number; stdout?: string; stderr?: string; timed_out?: boolean }>("POST", `/v1/containers/${id}/exec`, {
			json: { command, timeout_seconds: timeoutSeconds },
			signal,
		});
		return { exitCode: result.exit_code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: result.timed_out === true };
	}

	/** Run a command and return its output as one text with a status word, for tool results. */
	private async exec(command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: boolean; output: string; status: string }> {
		const r = await this.run(command, timeoutSeconds, signal);
		const output = [r.stdout, r.stderr ? `[stderr]\n${r.stderr}` : ""].filter(Boolean).join("\n");
		return { ok: !r.timedOut && r.exitCode === 0, output, status: r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}` };
	}

	/** Copy a local file into the sandbox (the site scans it first). Returns where it landed. */
	async put(path: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }> {
		const info = await stat(path).catch(() => undefined);
		if (!info?.isFile()) throw new ToolError(`${path} isn't a file.`);
		const id = await this.sandbox(signal);
		const boundary = `enrichedlab-${randomBytes(12).toString("hex")}`;
		const name = basename(path).replace(/["\r\n]/g, "_");
		const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
		const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
		const parts = async function* () {
			yield head;
			if (info.size) yield* createReadStream(path);
			yield tail;
		};
		return this.json<{ path: string; bytes: number }>("POST", `/v1/containers/${id}/files`, {
			body: Readable.toWeb(Readable.from(parts())) as unknown as ReadableStream,
			headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(head.length + info.size + tail.length) },
			signal,
		});
	}

	/** Stream a sandbox file to `target` through a temporary file. Returns its size and sha256. */
	async get(wanted: string, target: string, signal?: AbortSignal): Promise<{ bytes: number; sha: string }> {
		const id = await this.sandbox(signal);
		let after: string | undefined;
		let file: { id: string; path: string; bytes: number } | undefined;
		for (let page = 0; page < 50 && !file; page++) {
			const query = new URLSearchParams({ limit: "100", order: "asc" });
			if (after) query.set("after", after);
			const list = await this.json<{ data: { id: string; path: string; bytes: number }[]; has_more?: boolean }>("GET", `/v1/containers/${id}/files?${query}`, { signal });
			file = list.data.find((f) => f.path === wanted);
			if (!list.has_more || !list.data.length) break;
			after = list.data[list.data.length - 1].id;
		}
		if (!file) throw new ToolError(`There's no file ${wanted} in the sandbox.`);
		const response = await this.call("GET", `/v1/containers/${id}/files/${file.id}/content`, { signal });
		await mkdir(dirname(target), { recursive: true });
		const temp = `${target}.${randomBytes(4).toString("hex")}.part`;
		// Stream to disk: result files can be larger than the engine should hold in memory.
		let bytes = 0;
		const hash = createHash("sha256");
		try {
			const out = createWriteStream(temp, { mode: 0o600 });
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				bytes += chunk.length;
				hash.update(chunk);
				if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
			}
			await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));
			await rename(temp, target);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
		return { bytes, sha: hash.digest("hex") };
	}

	private sandboxTools(): Tool[] {
		const site = this.config.name;
		const run: Tool = {
			name: `${site}_sandbox_run`,
			kind: "sandbox",
			description: `Run a shell command in your ${site} sandbox: an isolated Linux machine with no network, which keeps its files while this engine runs. Files copied in with ${site}_sandbox_upload are there. Returns output and exit code. For anything over a few minutes use ${site}_sandbox_job_start.`,
			parameters: {
				type: "object",
				properties: { command: { type: "string" }, timeout: { type: "integer", description: "Seconds, default 120." } },
				required: ["command"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} sandbox`, target: String(a.command ?? "") }),
			run: async (args, ctx) => {
				const { ok, output, status } = await this.exec(str(args, "command"), num(args, "timeout") ?? 120, ctx.signal);
				return { ok, content: `${output}\n[${status}]`, view: { result: status, detail: output } };
			},
		};
		const jobStart: Tool = {
			name: `${site}_sandbox_job_start`,
			kind: "sandbox",
			description: `Start a long command in your ${site} sandbox as a background job and return its id at once. Check it with ${site}_sandbox_job_status.`,
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job`, target: String(a.command ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ id: string; status: string }>("POST", `/v1/containers/${id}/jobs`, { json: { command: str(args, "command") }, signal: ctx.signal });
				this.jobs.add(job.id);
				return { ok: true, content: `Job ${job.id}: ${job.status}`, view: { result: job.status } };
			},
		};
		const jobStatus: Tool = {
			name: `${site}_sandbox_job_status`,
			kind: "sandbox",
			description: `Status of a ${site} sandbox job, with the end of its log.`,
			parameters: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job`, target: String(a.job ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ id: string; status: string; exit_code?: number | null; log?: string }>(
					"GET",
					`/v1/containers/${id}/jobs/${encodeURIComponent(str(args, "job"))}?log_bytes=16000`,
					{ signal: ctx.signal },
				);
				const ended = job.exit_code !== null && job.exit_code !== undefined ? ` (exit ${job.exit_code})` : "";
				return { ok: true, content: `Job ${job.id}: ${job.status}${ended}\n${job.log ?? ""}`, view: { result: `${job.status}${ended}`, detail: job.log } };
			},
		};
		const jobCancel: Tool = {
			name: `${site}_sandbox_job_cancel`,
			kind: "sandbox",
			description: `Stop a ${site} sandbox job.`,
			parameters: { type: "object", properties: { job: { type: "string" } }, required: ["job"], additionalProperties: false },
			view: (a) => ({ verb: `${site} job stop`, target: String(a.job ?? "") }),
			run: async (args, ctx) => {
				const id = await this.sandbox(ctx.signal);
				const job = await this.json<{ status: string }>("POST", `/v1/containers/${id}/jobs/${encodeURIComponent(str(args, "job"))}/cancel`, { signal: ctx.signal });
				return { ok: true, content: `Job stopped: ${job.status}`, view: { result: job.status } };
			},
		};
		const upload: Tool = {
			name: `${site}_sandbox_upload`,
			kind: "sandbox",
			description: `Copy a file from the project folder into your ${site} sandbox (the site scans it first). Returns where it landed.`,
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
			view: (a) => ({ verb: `${site} upload`, target: String(a.path ?? "") }),
			ask: (a, { workspace }) => {
				const path = String(a.path ?? "");
				if (!workspace.inside(path)) return `${workspace.display(path)} is outside the project folder.`;
				let target = path;
				try {
					target = realpathSync(workspace.resolve(path));
				} catch {
					// Missing files fail in run().
				}
				if (SECRET_NAME.test(path) || SECRET_NAME.test(target)) return `${workspace.display(path)} looks like it holds secrets.`;
				return undefined;
			},
			run: async (args, ctx) => {
				const path = ctx.workspace.resolve(str(args, "path"));
				const placed = await this.put(path, ctx.signal);
				return { ok: true, content: `Copied to ${placed.path} (${placed.bytes} bytes).`, view: { result: `${(placed.bytes / 1024).toFixed(0)} KB` } };
			},
		};
		const download: Tool = {
			name: `${site}_sandbox_download`,
			kind: "write",
			description: `Copy a file from your ${site} sandbox into the project folder. Never replaces an existing file.`,
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "The file in the sandbox, e.g. /sandbox/out/result.csv" }, to: { type: "string", description: "A new path in the project folder." } },
				required: ["path", "to"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} download`, target: `${a.path ?? ""} → ${a.to ?? ""}` }),
			touches: (a) => [String(a.to ?? "")],
			ask: (a, { workspace }) => (workspace.inside(String(a.to ?? "")) ? undefined : `${workspace.display(String(a.to ?? ""))} is outside the project folder.`),
			run: async (args, ctx) => {
				const target = ctx.workspace.resolve(str(args, "to"));
				if (await stat(target).catch(() => undefined)) throw new ToolError(`${ctx.workspace.display(target)} already exists; choose a new name.`);
				if (/(^|[\\/])(\.git|\.ssh)([\\/]|$)/.test(target)) throw new ToolError("Downloads never go into .git or .ssh.");
				const wanted = str(args, "path");
				const { bytes, sha } = await this.get(wanted, target, ctx.signal);
				return { ok: true, content: `Saved ${wanted} to ${ctx.workspace.display(target)} (${bytes} bytes, sha256 ${sha}).`, view: { result: `${(bytes / 1024).toFixed(0)} KB` } };
			},
		};
		const repoSend: Tool = {
			name: `${site}_sandbox_repo_send`,
			kind: "sandbox",
			description: `Send this git repository to your ${site} sandbox: the current commit plus uncommitted and untracked files (files that look like secrets stay here). It lands on branch work in a new folder, which this returns. Work there with ${site}_sandbox_run and commit; bring the work back with ${site}_sandbox_repo_fetch.`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
			view: () => ({ verb: `${site} send repo`, target: "" }),
			ask: () => `It sends this repository, uncommitted files included, to ${site}.`,
			run: async (_args, ctx) => {
				const repo = repoRoot(ctx.workspace.root);
				if (!repo) throw new ToolError("The project folder isn't a git repository.");
				const id = randomBytes(4).toString("hex");
				const dir = `/sandbox/work/${basename(repo).replace(/[^\w.-]/g, "_")}-${id}`;
				const sent = await sendRepo(this, repo, dir, ctx.signal);
				this.sent.set(dir, { repo, base: sent.base });
				const left = sent.skipped.length ? ` Left out as likely secrets: ${sent.skipped.join(", ")}.` : "";
				return { ok: true, content: `Sent to ${dir} on branch work (${sent.head}).${left}`, view: { result: dir } };
			},
		};
		const repoFetch: Tool = {
			name: `${site}_sandbox_repo_fetch`,
			kind: "sandbox",
			description: `Bring the work in a sandbox folder made by ${site}_sandbox_repo_send back as a new local branch (uncommitted sandbox changes are committed first, as the person). The working folder and other branches stay as they are; the person reviews and merges the branch.`,
			parameters: { type: "object", properties: { folder: { type: "string", description: "The sandbox folder; default the last one sent." } }, additionalProperties: false },
			view: (a) => ({ verb: `${site} fetch repo`, target: String(a.folder ?? "") }),
			run: async (args, ctx) => {
				const dir = typeof args.folder === "string" && args.folder ? args.folder : [...this.sent.keys()].at(-1);
				const sent = dir ? this.sent.get(dir) : undefined;
				if (!dir || !sent) throw new ToolError(`No repository was sent to ${site} from this engine${dir ? ` as ${dir}` : ""}.`);
				const branch = `enrichedlab/${site}-${basename(dir).split("-").at(-1)}`;
				const commits = await fetchRepo(this, dir, sent, branch, ctx.signal);
				if (!commits.length) return { ok: true, content: `No new commits in ${dir} since it was sent.`, view: { result: "nothing new" } };
				return {
					ok: true,
					content: `Branch ${branch} has ${commits.length} commit${commits.length === 1 ? "" : "s"} from the sandbox:\n${commits.join("\n")}\nReview with git diff HEAD...${branch}; merge when it's right.`,
					view: { result: `${branch} · ${commits.length} commit${commits.length === 1 ? "" : "s"}`, detail: commits.join("\n") },
				};
			},
		};
		return [run, jobStart, jobStatus, jobCancel, upload, download, repoSend, repoFetch];
	}

	/** Stop using this connection but keep the sandbox: a reconnect (refresh, sign-in, route change) hands it on. */
	async detach(): Promise<string | undefined> {
		await this.mcp?.close().catch(() => undefined);
		const container = this.container;
		this.container = undefined;
		return container;
	}

	/** Engine shutdown: delete the sandbox unless a background job is still running in it; Gate expires it then. */
	async close(): Promise<void> {
		await this.mcp?.close().catch(() => undefined);
		const id = this.container;
		this.container = undefined;
		if (!id) return;
		for (const job of this.jobs) {
			const state = await this.json<{ status?: string }>("GET", `/v1/containers/${id}/jobs/${encodeURIComponent(job)}?log_bytes=0`, { signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
			if (state?.status === "running" || state?.status === "queued") return;
		}
		await this.call("DELETE", `/v1/containers/${id}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
	}
}

