// The Gate adapter: everything a person may use on a Gate site, read from Gate itself.
//
//   GET /v1/me          who they are, quotas, whether files and sandboxes are on
//   GET /v1/models      the models they may use, with context, output cap, reasoning levels and where levels go
//   POST /mcp           the tools their role grants (MCP, Streamable HTTP)
//   /v1/containers      their sandbox: run, background jobs, copy files in and out

import { hostname } from "node:os";
import { createReadStream, createWriteStream, realpathSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { BundleGrant } from "../bundles.ts";
import { repoRoot } from "../git.ts";
import { connectRemote, type McpConnection } from "../mcp.ts";
import { labFetch, sseData } from "../models/http.ts";
import { DeviceKey, dpopError } from "./dpop.ts";
import { type OpenPort, openPort } from "./port_proxy.ts";
import type { ModelProfile } from "../models/types.ts";
import { num, str, type Tool, ToolError } from "../tools/types.ts";
import { errorText, redact, SECRET_NAME, sleep } from "../util.ts";
import type { SiteAdapter } from "./adapter.ts";
import { fetchRepo, sendRepo } from "./repo_handoff.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import type { SiteConfig, SiteRoute } from "./sites.ts";
import { type CheckRow, CONTRACT, contractProblem, DESCRIPTOR_PATH, type Endpoint, type LabDescriptor, type LabEvent, SCHEMAS, validate } from "./contract.ts";

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

	/** This computer's key for the lab, when the lab binds tokens to devices (dpop.ts). */
	private device?: DeviceKey;
	/** The latest DPoP nonce the lab handed out, if it uses them. */
	private nonce?: string;
	/** Sandbox ports opened on this computer, by container and port. */
	private ports = new Map<string, OpenPort>();

	constructor(
		readonly config: SiteConfig,
		readonly route: SiteRoute,
		/** The sandbox an earlier connection to this site made; a reconnect keeps using it. */
		container?: string,
		/** Where this computer's device key for the lab is kept. */
		private deviceFile?: string,
	) {
		this.container = container;
	}

	/** The lab's public address for a request URL or path: proofs name it even when the request goes over the LAN. */
	private publicUrl(url: string): string {
		const pub = this.config.url.replace(/\/+$/, "");
		if (url.startsWith(this.route.base)) return pub + url.slice(this.route.base.length);
		return url.startsWith("/") ? pub + url : url;
	}

	/** The route's sign-in, plus a proof for this request when the lab binds tokens to devices. */
	private async authHeaders(method: string, url: string): Promise<Record<string, string>> {
		const headers = await this.route.headers();
		if (!this.device || this.device.revoked) return headers;
		const bearer = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(headers.authorization ?? "")?.[1];
		return { ...headers, dpop: await this.device.proof(method, this.publicUrl(url), bearer, this.nonce) };
	}

	/** Register this computer's key with the lab, once; the lab registers the key that signed the request. */
	private async enroll(): Promise<void> {
		if (!this.deviceFile) return;
		const key = await DeviceKey.open(this.deviceFile, this.config.url);
		if (key.revoked) throw Object.assign(new Error(`${this.title} revoked this computer's key. Sign in again (el login ${this.config.name}) to register a new one.`), { status: 401, revoked: true });
		this.device = key;
		if (key.id) return;
		const made = await this.json<{ id: string; thumbprint?: string }>("POST", "/v1/devices", { json: { name: `EnrichedLab on ${hostname().replace(/\.local$/i, "")}`, jwk: key.publicJwk }, signal: AbortSignal.timeout(15_000) });
		if (made.thumbprint && made.thumbprint !== key.thumbprint) throw new Error(`${this.title} registered a different key than this computer sent.`);
		key.registered(made.id);
	}

	async forget(): Promise<void> {
		const key = this.device ?? (this.deviceFile ? await DeviceKey.open(this.deviceFile, this.config.url) : undefined);
		if (key?.id && !key.revoked) await this.call("DELETE", `/v1/devices/${encodeURIComponent(key.id)}`, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
		key?.discard();
		this.device = undefined;
	}

	private async call(
		method: string,
		path: string,
		init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal; /** a proof to send instead of a fresh one (el lab check) */ dpop?: string } = {},
		retried = false,
	): Promise<Response> {
		const headers: Record<string, string> = { accept: "application/json", ...init.headers, ...(await this.authHeaders(method, path)) };
		if (init.dpop !== undefined) headers.dpop = init.dpop;
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
		const nonce = response.headers.get("dpop-nonce");
		if (nonce) this.nonce = nonce;
		if (response.status === 304) return response;
		if (response.status >= 300 && response.status < 400) throw new Error(`${this.config.name} asked for a sign-in. Run el login ${this.config.name}.`);
		const refused = response.status === 401 || response.status === 400 ? dpopError(response) : undefined;
		if (refused && init.dpop === undefined) {
			const again = !retried && !streamed;
			if (refused === "use_dpop_nonce" && nonce && again) return this.call(method, path, init, true);
			if ((refused === "device_unregistered" || refused === "device_proof_required") && again && this.deviceFile && path !== "/v1/devices") {
				// No proof was sent: load (or register) this computer's key. The lab lost the key: register a new one.
				await response.arrayBuffer();
				this.device = undefined;
				if (refused === "device_unregistered") {
					const key = await DeviceKey.open(this.deviceFile, this.config.url);
					if (key.id && !key.revoked) key.discard();
				}
				await this.enroll();
				return this.call(method, path, init, true);
			}
			if (refused === "device_revoked") {
				// A revoked key is not replaced on its own: the person signs in again first.
				this.device?.markRevoked();
				throw Object.assign(new Error(`${this.title} revoked this computer's key. Sign in again (el login ${this.config.name}) to register a new one.`), { status: 401 });
			}
		}
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

	/** A GET that sends the last ETag: a 304 answers from the copy kept here. */
	private async cached<T>(path: string, signal?: AbortSignal): Promise<T> {
		const kept = this.etags.get(path);
		const response = await this.call("GET", path, { headers: kept ? { "if-none-match": kept.etag } : {}, signal });
		if (response.status === 304 && kept) return kept.body as T;
		const body = (await response.json()) as T;
		const etag = response.headers.get("etag");
		if (etag) this.etags.set(path, { etag, body });
		return body;
	}
	private etags = new Map<string, { etag: string; body: unknown }>();

	descriptor?: LabDescriptor;

	/** The lab's own description, or undefined from a lab that predates it (then endpoints are probed). */
	private async readDescriptor(): Promise<LabDescriptor | undefined> {
		try {
			return await this.cached<LabDescriptor>(DESCRIPTOR_PATH, AbortSignal.timeout(10_000));
		} catch {
			return undefined;
		}
	}

	/** Whether the lab serves an endpoint: what its description says, or "try it" without one. */
	private offers(endpoint: Endpoint): boolean {
		return this.descriptor ? this.descriptor.endpoints[endpoint] === true : true;
	}

	async connect(): Promise<void> {
		this.descriptor = await this.readDescriptor();
		if (this.descriptor) {
			const problem = contractProblem(this.descriptor);
			if (problem) throw new Error(problem);
			const fit = validate(SCHEMAS.lab, this.descriptor);
			if (fit.length) this.warning = `${this.title}'s description doesn't fit the lab contract (${fit[0]}).`;
		}
		if (this.offers("devices") && this.deviceFile) {
			try {
				await this.enroll();
			} catch (error) {
				// Proofs are optional at this lab: work without them and say so. A required proof or a revoked key stops here.
				if (this.descriptor?.policy?.device_proof === "required" || (error as { revoked?: boolean }).revoked) throw error;
				this.device = undefined;
				this.warning = `Couldn't register this computer's key with ${this.title} (${redact(errorText(error))}).`;
			}
		}
		const me = await this.cached<GateMe>("/v1/me", AbortSignal.timeout(10_000));
		this.who = me.handle;
		this.owner = me.owner === true;
		this.sandboxOn = me.sandboxes?.enabled === true;
		const list = await this.cached<{ data?: GateModel[] }>("/v1/models", AbortSignal.timeout(10_000));
		this.models = (list.data ?? []).filter((m) => !m.gate?.endpoints?.length || m.gate.endpoints.includes("chat")).map((m) => this.profile(m));
		const tools: Tool[] = [];
		try {
			this.mcp = await connectRemote(this.config.name, { url: `${this.route.base}/mcp`, headers: (request) => this.authHeaders(request.method, request.url), ca: this.route.ca, origin: "site" });
			tools.push(...this.mcp.tools);
		} catch (error) {
			this.warning = `Tools unavailable: ${redact(errorText(error))}`;
		}
		if (this.sandboxOn) tools.push(...this.sandboxTools());
		this.tools = tools;
	}

	get title(): string {
		return this.config.title ?? this.descriptor?.title ?? this.config.name;
	}

	sandboxApi(): SandboxApi | undefined {
		return this.sandboxOn ? this : undefined;
	}

	/** Bundles this person's role is granted, from GET /v1/bundles. A Gate that doesn't serve it grants none. */
	async bundles(): Promise<BundleGrant[]> {
		if (!this.offers("bundles")) return [];
		try {
			const list = await this.cached<{ data?: BundleGrant[] }>("/v1/bundles", AbortSignal.timeout(10_000));
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

	// ── Lab contract: events, files by reference, usage, conformance ─────────────────────────────────────────────

	/** Follow GET /v1/events from `cursor`, reconnecting with backoff. A `reset` event means re-read what was granted. */
	follow(cursor: string | undefined, on: { event(e: LabEvent): void; cursor(id: string): void; reset(): void }): () => void {
		const controller = new AbortController();
		if (!this.offers("events")) return () => undefined;
		let last = cursor;
		void (async () => {
			let wait = 2_000;
			while (!controller.signal.aborted) {
				try {
					const response = await this.call("GET", "/v1/events", { headers: { accept: "text/event-stream", ...(last ? { "last-event-id": last } : {}) }, signal: controller.signal });
					if (!response.body) throw new Error("The lab sent no event stream.");
					wait = 2_000;
					for await (const message of sseData(response.body, controller.signal)) {
						if (message.event === "reset") {
							on.reset();
							let next = message.id;
							try {
								next = (JSON.parse(message.data) as { cursor?: string }).cursor ?? next;
							} catch {
								// The id field carries the cursor.
							}
							if (next) on.cursor((last = next));
							continue;
						}
						let event: LabEvent;
						try {
							event = JSON.parse(message.data) as LabEvent;
						} catch {
							continue;
						}
						if (message.id) on.cursor((last = message.id));
						if (typeof event.type === "string") on.event(event);
					}
				} catch (error) {
					if (controller.signal.aborted) return;
					// A lab without the stream, or a sign-in that ended: stop; the next connect starts again.
					const status = (error as { status?: number }).status;
					if (status === 404 || status === 401 || status === 403) return;
				}
				await sleep(wait, controller.signal).catch(() => undefined);
				wait = Math.min(wait * 2, 60_000);
			}
		})();
		return () => controller.abort();
	}

	/** A file a lab tool returned by reference. Only the lab's own addresses are fetched, with the lab's sign-in. */
	async fetchFile(uri: string, signal: AbortSignal): Promise<Uint8Array> {
		const base = [this.route.base, new URL(this.config.url).origin].find((b) => uri === b || uri.startsWith(`${b}/`));
		if (!base) throw new Error(`${uri} isn't an address of ${this.title}.`);
		const response = await this.call("GET", uri.slice(base.length), { headers: { accept: "*/*" }, signal });
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Use by lab and group (GET /v1/usage). */
	async usage(window: "7d" | "30d"): Promise<unknown> {
		if (!this.offers("usage")) throw new Error(`${this.title} doesn't report usage.`);
		return this.json("GET", `/v1/usage?window=${window}`, { signal: AbortSignal.timeout(15_000) });
	}

	/**
	 * `el lab check`: read the description, then exercise each endpoint it lists against contract/. Read-only apart
	 * from one sandbox it makes and deletes, and one guard call with harmless text.
	 */
	async check(): Promise<CheckRow[]> {
		const rows: CheckRow[] = [];
		const add = (row: string, status: CheckRow["status"], detail?: string) => rows.push({ row, status, ...(detail ? { detail } : {}) });
		const fits = (row: string, schema: keyof typeof SCHEMAS, value: unknown, note?: string) => {
			const problems = validate(SCHEMAS[schema], value);
			add(row, problems.length ? "fail" : "pass", problems.length ? problems.slice(0, 3).join("; ") : note);
		};
		const attempt = async (row: string, run: () => Promise<unknown>) => {
			try {
				await run();
			} catch (error) {
				add(row, "fail", redact(errorText(error)));
			}
		};
		const t = () => AbortSignal.timeout(20_000);

		let d: LabDescriptor | undefined;
		await attempt("descriptor", async () => {
			const response = await this.call("GET", DESCRIPTOR_PATH, { signal: t() });
			d = (await response.json()) as LabDescriptor;
			fits("descriptor", "lab", d, `${d.title}, contract ${d.contract}`);
			const problem = contractProblem(d);
			add("contract version", problem ? "fail" : "pass", problem ?? `${d.contract} (this client: ${CONTRACT})`);
		});
		const has = (endpoint: Endpoint) => d?.endpoints?.[endpoint] === true;
		const skip = (row: string) => add(row, "skip", "not listed in the descriptor");

		await attempt("GET /v1/me", async () => fits("GET /v1/me", "me", await this.json("GET", "/v1/me", { signal: t() })));
		await attempt("ETag on /v1/me", async () => {
			const first = await this.call("GET", "/v1/me", { signal: t() });
			const etag = first.headers.get("etag");
			await first.arrayBuffer();
			if (!etag) return add("ETag on /v1/me", "fail", "no ETag header");
			const again = await this.call("GET", "/v1/me", { headers: { "if-none-match": etag }, signal: t() });
			await again.arrayBuffer();
			// A proxy that compresses (Cloudflare does) turns a strong ETag into a weak one; If-None-Match must still match.
			const weak = etag.startsWith("W/") ? `; the ETag arrived weak (${etag}), so compare without the W/ prefix (RFC 9110 weak comparison)` : "";
			add("ETag on /v1/me", again.status === 304 ? "pass" : "fail", again.status === 304 ? undefined : `answered ${again.status} to If-None-Match${weak}`);
		});
		await attempt("GET /v1/models", async () => {
			const list = await this.json<{ data?: unknown[] }>("GET", "/v1/models", { signal: t() });
			fits("GET /v1/models", "models", list, `${list.data?.length ?? 0} models`);
		});

		if (has("devices")) {
			const key = this.device;
			if (!key?.id) add("device key", "fail", this.warning ?? "this computer's key isn't registered");
			else {
				await attempt("device key", async () => {
					const listed = await this.json<unknown>("GET", "/v1/devices", { signal: t() });
					const devices = (Array.isArray(listed) ? listed : ((listed as { data?: unknown[] }).data ?? [])) as { id?: string; thumbprint?: string; current?: boolean; revoked?: boolean }[];
					const mine = devices.find((x) => x.id === key.id);
					const fits = mine && mine.thumbprint === key.thumbprint && !mine.revoked;
					add("device key", fits ? "pass" : "fail", !mine ? "the lab doesn't list this computer's key" : fits ? `registered${mine.current ? ", marked current" : ""}` : "listed with another thumbprint or revoked");
				});
				// A lab that accepts these bound nothing: each must be refused.
				const bearer = /^(?:Bearer|DPoP)\s+(.+)$/i.exec((await this.route.headers()).authorization ?? "")?.[1];
				const status = (dpop: string) =>
					this.call("GET", "/v1/me", { dpop, signal: t() }).then(
						async (r) => (await r.arrayBuffer(), r.status),
						(e: { status?: number }) => e.status,
					);
				const me = this.publicUrl("/v1/me");
				await attempt("proof for another token", async () => {
					const got = await status(await key.proof("GET", me, "not-the-token-this-request-carries"));
					add("proof for another token", got === 401 ? "pass" : "fail", `answered ${got ?? "?"}`);
				});
				await attempt("proof for another address", async () => {
					const got = await status(await key.proof("GET", this.publicUrl("/v1/models"), bearer));
					add("proof for another address", got === 401 ? "pass" : "fail", `answered ${got ?? "?"}`);
				});
				await attempt("proof used twice", async () => {
					const proof = await key.proof("GET", me, bearer);
					const first = await status(proof);
					const second = await status(proof);
					add("proof used twice", first === 200 && second === 401 ? "pass" : "fail", `first ${first ?? "?"}, again ${second ?? "?"}`);
				});
			}
		} else skip("device key");

		if (has("mcp") || !d) {
			await attempt("MCP tools", async () => {
				const connection = await connectRemote(`${this.config.name}-check`, { url: `${this.route.base}/mcp`, headers: (request) => this.authHeaders(request.method, request.url), ca: this.route.ca, origin: "site" });
				const unreviewed = connection.tools.filter((tool) => tool.unreviewed).length;
				add("MCP tools", "pass", `${connection.tools.length} tools${unreviewed ? `, ${unreviewed} unreviewed` : ""}`);
				const data = d?.conformance?.data_tool;
				if (data) {
					const tool = connection.tools.find((x) => x.name.endsWith(`_${data.name}`) || x.name === data.name);
					if (!tool) add("data by reference", "fail", `no tool named ${data.name}`);
					else {
						const result = await tool.run(data.arguments ?? {}, { signal: t() } as never);
						const files = result.view?.files ?? [];
						if (!files.length && result.content.length < 2_000) {
							// Nothing to list proves nothing either way; the lab can name arguments that always return a sample file.
							add("data by reference", "skip", `the tool returned no files ("${result.content.trim().slice(0, 80)}"); give conformance.data_tool arguments that return a sample file`);
						} else {
							const referenced = files.length > 0 && files.every((f) => f.sha256);
							add("data by reference", referenced && result.content.length < 20_000 ? "pass" : "fail", referenced ? `${files.length} files with checksums` : "the result carried no file references with checksums");
						}
					}
				} else add("data by reference", "skip", "the descriptor names no conformance.data_tool");
				await connection.close();
			});
		} else skip("MCP tools");

		if (has("bundles")) await attempt("GET /v1/bundles", async () => fits("GET /v1/bundles", "bundles", await this.json("GET", "/v1/bundles", { signal: t() })));
		else skip("GET /v1/bundles");

		if (has("guard")) {
			await attempt("POST /v1/guard", async () => {
				const answer = await this.json<{ decision?: string }>("POST", "/v1/guard", { json: { stage: "input", text: "Summarize the yield table by treatment." }, signal: t() });
				fits("POST /v1/guard", "guard", answer, `decision ${answer.decision}`);
				if (answer.decision === "block") add("guard on harmless text", "fail", "it blocked a plain request");
			});
		} else skip("POST /v1/guard");

		if (has("usage")) {
			await attempt("GET /v1/usage", async () => fits("GET /v1/usage", "usage", await this.json("GET", "/v1/usage?window=7d", { signal: t() })));
			const foreign = d?.conformance?.foreign_scope;
			if (foreign) {
				await attempt("another lab's scope", async () => {
					const response = await this.call("GET", `/v1/usage?window=7d&lab=${encodeURIComponent(foreign)}`, { signal: t() }).catch((error: { status?: number }) => error);
					const status = response instanceof Response ? response.status : response.status;
					add("another lab's scope", status === 403 || status === 404 ? "pass" : "fail", `answered ${status ?? "?"}`);
				});
			} else add("another lab's scope", "skip", "the descriptor names no conformance.foreign_scope");
		} else skip("GET /v1/usage");

		if (has("containers")) {
			await attempt("sandbox", async () => {
				const profile = d?.sandbox_profiles?.[0]?.name;
				const made = await this.json<{ id: string }>("POST", "/v1/containers", { json: { name: "el-lab-check", ...(profile ? { profile } : {}) }, signal: AbortSignal.timeout(300_000) });
				fits("sandbox made", "container", made, profile ? `profile ${profile}` : undefined);
				try {
					const ran = await this.json<{ exit_code?: number; stdout?: string }>("POST", `/v1/containers/${made.id}/exec`, { json: { command: "echo ok", timeout_seconds: 30 }, signal: AbortSignal.timeout(120_000) });
					add("sandbox runs a command", ran.exit_code === 0 && ran.stdout?.trim() === "ok" ? "pass" : "fail", `exit ${ran.exit_code}`);
					if (has("ports")) {
						// A web server in the sandbox, read through the lab's port path; app pages must come sandboxed (CSP).
						const served = await this.json<{ exit_code?: number }>("POST", `/v1/containers/${made.id}/exec`, {
							json: { command: "command -v python3 >/dev/null || exit 3; mkdir -p /tmp/el-check && echo el-port-ok > /tmp/el-check/index.html && (cd /tmp/el-check && nohup python3 -m http.server 8765 >/dev/null 2>&1 &) && sleep 2", timeout_seconds: 30 },
							signal: AbortSignal.timeout(60_000),
						});
						if (served.exit_code === 3) add("sandbox port", "skip", "the sandbox image has no python3 to serve a page");
						else {
							const page = await this.call("GET", `/v1/containers/${made.id}/ports/8765/`, { headers: { accept: "text/html" }, signal: t() }).catch((error: { status?: number; message?: string }) => error);
							if (!(page instanceof Response)) add("sandbox port", "fail", `answered ${page.status ?? page.message}`);
							else {
								const text = await page.text();
								const csp = page.headers.get("content-security-policy") ?? "";
								add("sandbox port", text.includes("el-port-ok") ? "pass" : "fail", text.includes("el-port-ok") ? "the page came through" : `answered ${page.status} without the page`);
								add("app pages sandboxed", /(^|;)\s*sandbox\b/.test(csp) ? "pass" : "fail", csp ? `Content-Security-Policy: ${csp.slice(0, 80)}` : "no Content-Security-Policy");
							}
						}
					}
				} finally {
					await this.call("DELETE", `/v1/containers/${made.id}`, { signal: t() }).catch(() => undefined);
				}
			});
		} else skip("sandbox");
		if (has("events")) {
			await attempt("GET /v1/events", async () => {
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 25_000);
				try {
					const response = await this.call("GET", "/v1/events", { headers: { accept: "text/event-stream", "last-event-id": "0" }, signal: controller.signal });
					const type = response.headers.get("content-type") ?? "";
					if (!type.includes("text/event-stream")) return add("GET /v1/events", "fail", `content type ${type || "none"}`);
					add("GET /v1/events", "pass", "the stream opens");
					let seen = "";
					for await (const message of sseData(response.body!, controller.signal)) {
						if (message.event === "reset") {
							seen = "reset";
							break;
						}
						const problems = validate(SCHEMAS.event, JSON.parse(message.data));
						if (problems.length) {
							seen = `bad event: ${problems[0]}`;
							break;
						}
						if (!message.id) {
							seen = "an event without an id";
							break;
						}
						seen = "events";
						break;
					}
					if (!seen) add("old cursor", "skip", "no events within 25 s");
					else add("old cursor", seen === "reset" || seen === "events" ? "pass" : "fail", seen === "reset" ? "a cursor older than the history kept gets reset" : seen === "events" ? "resumes from the cursor" : seen);
				} catch (error) {
					if (!controller.signal.aborted) throw error;
					if (!rows.some((r) => r.row === "old cursor")) add("old cursor", "skip", "no events within 25 s");
				} finally {
					clearTimeout(timer);
					controller.abort();
				}
			});
		} else skip("GET /v1/events");

		return rows;
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
		const openPortTool: Tool = {
			name: `${site}_sandbox_open_port`,
			kind: "sandbox",
			description: `Open a web app running in your ${site} sandbox (Shiny, Streamlit, a dev server) in the browser pane. Start the app first, in the background (${site}_sandbox_job_start), listening on 0.0.0.0 at that port. Returns the page, or a local address when no window is open.`,
			parameters: {
				type: "object",
				properties: { port: { type: "integer", minimum: 1, maximum: 65535 }, path: { type: "string", description: "Path to open, default /" } },
				required: ["port"],
				additionalProperties: false,
			},
			view: (a) => ({ verb: `${site} sandbox`, target: `open port ${a.port}` }),
			run: async (args, ctx) => {
				const opened = await this.openPort(num(args, "port") ?? 0, typeof args.path === "string" ? args.path : "/", ctx.signal);
				if (ctx.surface) {
					const page = await ctx.surface.call("browser", "open", { url: opened.url }, ctx.signal).catch(() => undefined);
					if (page) return { ok: true, content: page.text, view: { result: `opened ${opened.origin}` } };
				}
				return { ok: true, content: `Open ${opened.url} in a browser on this computer. The address works only here, while this engine runs.`, view: { result: opened.origin } };
			},
		};
		return [run, jobStart, jobStatus, jobCancel, upload, download, repoSend, repoFetch, ...(this.offers("ports") ? [openPortTool] : [])];
	}

	/** Stop using this connection but keep the sandbox: a reconnect (refresh, sign-in, route change) hands it on. */
	async detach(): Promise<string | undefined> {
		await this.mcp?.close().catch(() => undefined);
		const container = this.container;
		this.container = undefined;
		return container;
	}

	/** Engine shutdown: delete the sandbox unless a background job is still running in it; Gate expires it then. */
	/** Open a port of the sandbox on this computer (port_proxy.ts); one loopback address per port, reused. */
	async openPort(port: number, path = "/", signal?: AbortSignal): Promise<OpenPort> {
		if (!this.offers("ports")) throw new Error(`${this.title} doesn't open sandbox ports.`);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError("Give a port from 1 to 65535.");
		const id = await this.sandbox(signal);
		const kept = this.ports.get(`${id}:${port}`);
		if (kept) return kept;
		const prefix = `${this.route.base}/v1/containers/${encodeURIComponent(id)}/ports/${port}`;
		const opened = openPort({ url: (p) => `${prefix}${p}`, headers: (method, url) => this.authHeaders(method, url), ca: this.route.ca }, path);
		this.ports.set(`${id}:${port}`, opened);
		return opened;
	}

	async close(): Promise<void> {
		for (const opened of this.ports.values()) opened.close();
		this.ports.clear();
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

