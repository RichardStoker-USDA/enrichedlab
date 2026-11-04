// Sites: places that sign a person in and grant them models, tools and sandboxes. The site decides access; the
// engine reads what it was granted and applies it. `sites.json` holds addresses; `credentials/<site>.json` holds
// tokens, owner-only. A site can also be reached on the LAN with a key file and a private CA.

import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SiteSummary } from "@enrichedlab/protocol";
import type { ModelProfile } from "../models/types.ts";
import type { Paths } from "../paths.ts";
import type { Tool } from "../tools/types.ts";
import { errorText, expandHome, readJson, readSecret, redact, writeJson } from "../util.ts";
import { syncSiteBundles } from "../bundles.ts";
import type { ModelSource } from "../models/registry.ts";
import { SITE_KINDS, type SiteAdapter } from "./adapter.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import { login, refresh, type SavedClient, type SiteCredentials } from "./oauth.ts";

export interface SiteConfig {
	/** Short id: CLI arguments and tool name prefixes (enrichedlab_sandbox_run). */
	name: string;
	/** What people see: the lab's name. Defaults to the short name. */
	title?: string;
	/** The site's public address (behind Cloudflare Access). */
	url: string;
	/** Which adapter speaks to it (see SITE_KINDS). */
	kind: string;
	/**
	 * Research or other bounded data: only sessions bound to this site see its tools and models, and those sessions
	 * work in the site's sandbox with the site's models only, without the person's web or local MCP tools, so code
	 * and data stay in the site.
	 */
	isolated?: boolean;
	/** Optional LAN route: a key instead of the browser sign-in. */
	lan?: { url: string; keyFile: string; caFile?: string };
	/** Use the LAN route even when an OAuth sign-in exists. */
	preferLan?: boolean;
}

interface StoredCredentials {
	oauth?: SiteCredentials;
	client?: SavedClient;
}

/** How a site is reached right now: an address, headers with credentials, and a CA when it has its own. */
export interface SiteRoute {
	base: string;
	via: "oauth" | "key";
	headers(): Promise<Record<string, string>>;
	ca?: string;
}

export interface SiteState {
	config: SiteConfig;
	route?: SiteRoute;
	who?: string;
	models: ModelProfile[];
	tools: Tool[];
	sandbox: boolean;
	error?: string;
	warning?: string;
	describe: string;
}

export class Sites {
	private states = new Map<string, SiteState>();
	private adapters = new Map<string, SiteAdapter>();
	/** Sandboxes whose site couldn't be reached on the last connect; the next connect picks them up. */
	private parked = new Map<string, string>();

	constructor(
		private p: Paths,
		private onChange: (summary: SiteSummary) => void,
	) {}

	configs(): SiteConfig[] {
		return readJson<{ sites?: SiteConfig[] }>(this.p.sites, {}).sites ?? [];
	}

	private saveConfigs(sites: SiteConfig[]): void {
		writeJson(this.p.sites, { sites }, true);
	}

	add(config: SiteConfig): void {
		// A name pointed at a new address loses its sign-in: tokens belong to the address they were issued for.
		const before = this.configs().find((s) => s.name === config.name);
		if (before && origin(before.url) !== origin(config.url)) rmSync(this.credPath(config.name), { force: true });
		const sites = this.configs().filter((s) => s.name !== config.name);
		sites.push(config);
		this.saveConfigs(sites);
	}

	/** Give a site a new short name (and title); its sign-in moves with it. */
	rename(from: string, to: string, title?: string): SiteConfig {
		const sites = this.configs();
		const site = sites.find((s) => s.name === from);
		if (!site) throw new Error(`No site named ${from}.`);
		if (from !== to && sites.some((s) => s.name === to)) throw new Error(`A site named ${to} already exists.`);
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(to)) throw new Error("Site names are lowercase letters, digits, - and _, starting with a letter.");
		const renamed = { ...site, name: to, title: title ?? site.title };
		if (from !== to && existsSync(this.credPath(from))) renameSync(this.credPath(from), this.credPath(to));
		this.saveConfigs(sites.map((s) => (s.name === from ? renamed : s)));
		this.adapters.delete(from);
		this.states.delete(from);
		return renamed;
	}

	/** A signed-in site's sandbox as a place to work, when the site offers one. */
	sandbox(name: string): SandboxApi | undefined {
		return this.adapters.get(name)?.sandboxApi?.();
	}

	title(name: string): string {
		return this.configs().find((s) => s.name === name)?.title ?? name;
	}

	private credPath(name: string): string {
		return join(this.p.credentials, `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
	}

	private creds(name: string): StoredCredentials {
		return readJson<StoredCredentials>(this.credPath(name), {});
	}

	private saveCreds(name: string, creds: StoredCredentials): void {
		writeJson(this.credPath(name), creds, true);
	}

	/** Pick the route: OAuth on the public address when signed in, else the LAN key when configured. */
	route(config: SiteConfig, forceLan = false): SiteRoute | undefined {
		const creds = this.creds(config.name);
		// Never send a token to an address other than the one it was issued for.
		if (creds.oauth && origin(creds.oauth.resource) !== origin(config.url)) creds.oauth = undefined;
		const lan = config.lan && readSecret({ keyFile: config.lan.keyFile }) ? config.lan : undefined;
		const useLan = lan && (forceLan || config.preferLan || !creds.oauth);
		if (useLan && lan) {
			const ca = lan.caFile ? readFileSync(expandHome(lan.caFile), "utf8") : undefined;
			return { base: lan.url.replace(/\/+$/, ""), via: "key", ca, headers: async () => ({ authorization: `Bearer ${readSecret({ keyFile: lan.keyFile })}` }) };
		}
		if (creds.oauth) {
			let current = creds.oauth;
			// One refresh at a time: requests that find the token expired together wait for the same new one, since a
			// rotated refresh token works once.
			let refreshing: Promise<SiteCredentials> | undefined;
			return {
				base: config.url.replace(/\/+$/, ""),
				via: "oauth",
				headers: async () => {
					if (Date.now() >= current.expires) {
						refreshing ??= refresh(current)
							.then((next) => {
								current = next;
								this.saveCreds(config.name, { ...this.creds(config.name), oauth: next });
								return next;
							})
							.finally(() => {
								refreshing = undefined;
							});
						await refreshing;
					}
					return { authorization: `Bearer ${current.access}` };
				},
			};
		}
		return undefined;
	}

	/** Browser sign-in. `onAuth` gets the address to open. */
	async login(name: string, onAuth: (url: string, instructions: string) => void, signal?: AbortSignal): Promise<SiteSummary> {
		const config = this.configs().find((s) => s.name === name);
		if (!config) throw new Error(`No site named ${name}. Add it with el site add ${name} <address>.`);
		const stored = this.creds(name);
		const result = await login(config.url, { onAuth: ({ url, instructions }) => onAuth(url, instructions ?? ""), signal }, stored.client);
		this.saveCreds(name, { oauth: result.credentials, client: result.client });
		return this.connect(name);
	}

	logout(name: string): void {
		rmSync(this.credPath(name), { force: true });
		this.adapters.get(name)?.close();
		this.adapters.delete(name);
		this.states.delete(name);
		const config = this.configs().find((s) => s.name === name);
		if (config) void this.connect(name).catch(() => undefined);
	}

	/** Connect (or reconnect) one site and read what this person was granted. */
	async connect(name: string): Promise<SiteSummary> {
		const config = this.configs().find((s) => s.name === name);
		if (!config) throw new Error(`No site named ${name}.`);
		// The old connection goes, its sandbox stays: files and running jobs survive a refresh.
		const container = (await this.adapters.get(name)?.detach()) ?? this.parked.get(name);
		this.adapters.delete(name);
		this.parked.delete(name);
		const first = this.route(config);
		const state: SiteState = { config, route: first, models: [], tools: [], sandbox: false, describe: config.name };
		// A rejected browser sign-in falls back to the LAN key when one is configured, and says so.
		const routes = [first, first?.via === "oauth" && config.lan ? this.route(config, true) : undefined].filter(Boolean) as SiteRoute[];
		const factory = Object.hasOwn(SITE_KINDS, config.kind) ? SITE_KINDS[config.kind] : undefined;
		if (!factory) state.error = `This version of EnrichedLab doesn't know sites of kind "${config.kind}".`;
		for (const route of routes) {
			if (!factory) break;
			const adapter = factory(config, route, container);
			try {
				await adapter.connect();
				this.adapters.set(name, adapter);
				if (adapter.bundles) {
					try {
						syncSiteBundles(this.p, name, await adapter.bundles());
					} catch (error) {
						state.warning = `Bundles from ${name} weren't installed: ${redact(errorText(error))}`;
					}
				}
				const note = route !== first && state.error ? `Browser sign-in refused; using the LAN key. ${state.error}` : adapter.warning;
				Object.assign(state, { route, who: adapter.who, models: adapter.models, tools: adapter.tools, sandbox: adapter.sandboxOn, error: undefined, warning: note ?? state.warning, describe: adapter.describe() });
				break;
			} catch (error) {
				state.error = redact(errorText(error));
			}
		}
		if (!this.adapters.has(name) && container) this.parked.set(name, container);
		this.states.set(name, state);
		const summary = this.summary(state);
		this.onChange(summary);
		return summary;
	}

	async connectAll(): Promise<void> {
		await Promise.all(this.configs().map((c) => this.connect(c.name).catch(() => undefined)));
	}

	summary(state: SiteState): SiteSummary {
		return {
			name: state.config.name,
			title: state.config.title ?? state.config.name,
			url: state.config.url,
			kind: state.config.kind,
			isolated: state.config.isolated,
			signedIn: Boolean(state.route && !state.error),
			who: state.who,
			via: state.route?.via,
			models: state.models.length,
			tools: state.tools.length,
			sandbox: state.sandbox,
			error: state.error,
			warning: state.warning,
		};
	}

	list(): SiteSummary[] {
		return this.configs().map((c) => {
			const state = this.states.get(c.name);
			return state ? this.summary(state) : { name: c.name, title: c.title ?? c.name, url: c.url, kind: c.kind, isolated: c.isolated, signedIn: false, models: 0, tools: 0, sandbox: false };
		});
	}

	/** Model sources for the registry: one per connected site. */
	modelSources(): ModelSource[] {
		return [...this.states.values()].map((s) => ({ name: `site:${s.config.name}`, models: () => s.models }));
	}

	/** The sites a session sees: the one it is bound to, or every site that isn't isolated. */
	private visible(site?: string): SiteState[] {
		return [...this.states.values()].filter((s) => (site ? s.config.name === site : !s.config.isolated));
	}

	tools(site?: string): Tool[] {
		return this.visible(site).flatMap((s) => s.tools);
	}

	descriptions(site?: string): string[] {
		return this.visible(site)
			.filter((s) => s.route && !s.error)
			.map((s) => s.describe);
	}

	/** Whether a session (bound to `site`, or unbound) may use this model. Models from this computer or the
	 * person's own providers always may. */
	allows(model: ModelProfile, site?: string): boolean {
		// A session bound to an isolated site uses that site's models only, so its data never goes elsewhere.
		if (site && this.isolated(site)) return model.source === "site" && model.provider === site;
		if (model.source !== "site") return true;
		if (site) return model.provider === site;
		return !this.isolated(model.provider);
	}

	isolated(name: string): boolean {
		return this.configs().find((c) => c.name === name)?.isolated === true;
	}

	exists(name: string): boolean {
		return this.configs().some((c) => c.name === name);
	}

	async close(): Promise<void> {
		await Promise.all([...this.adapters.values()].map((a) => a.close()));
	}
}

function origin(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}
