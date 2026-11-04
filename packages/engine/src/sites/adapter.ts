// The seam every kind of site plugs into. A site signs a person in somewhere (Cloudflare Access, a LAN key) and
// grants them models, tools and a sandbox; an adapter turns one site's API into those. Gate is the first kind; the
// a research broker is the next kind. Add a kind by writing an adapter and registering it in SITE_KINDS.

import type { BundleGrant } from "../bundles.ts";
import type { CheckRow, LabDescriptor, LabEvent } from "./contract.ts";
import type { ModelProfile } from "../models/types.ts";
import type { Tool } from "../tools/types.ts";
import { GateSite } from "./gate.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import type { SiteConfig, SiteRoute } from "./sites.ts";

export interface SiteAdapter {
	/** Who the site says the person is. */
	readonly who?: string;
	/** The models and tools this person was granted, read at connect. */
	readonly models: ModelProfile[];
	readonly tools: Tool[];
	readonly sandboxOn: boolean;
	/** Connected, with something the person should know. */
	readonly warning?: string;
	/** Read what the person was granted. Throws when the site refuses or can't be reached. */
	connect(): Promise<void>;
	/** One line for the system prompt: what this site is and what it offers. */
	describe(): string;
	/** The site's sandbox as a place sessions can work in, when this person has one. */
	sandboxApi?(): SandboxApi | undefined;
	/** Bundles the site grants this person (by role, group or project). Optional; a site without any omits it. */
	bundles?(): Promise<BundleGrant[]>;
	/** Stop using this connection but keep remote state (a sandbox); returns a handle the next adapter takes over. */
	detach(): Promise<string | undefined>;
	/** Engine shutdown or sign-out: release remote state. */
	close(): Promise<void>;
	/** What the lab says about itself at /.well-known/enrichedlab-lab, when it serves that. */
	readonly descriptor?: LabDescriptor;
	/** Follow the lab's event stream until stopped; `reset` means re-read what was granted. */
	follow?(cursor: string | undefined, on: { event(e: LabEvent): void; cursor(id: string): void; reset(): void }): () => void;
	/** A file the lab returned by reference, if `uri` is one of the lab's own addresses. */
	fetchFile?(uri: string, signal: AbortSignal): Promise<Uint8Array>;
	/** Use by lab and group over a window. */
	usage?(window: "7d" | "30d"): Promise<unknown>;
	/** Exercise every endpoint the lab lists, for `el lab check`. */
	check?(): Promise<CheckRow[]>;
}

export type SiteAdapterFactory = (config: SiteConfig, route: SiteRoute, carried?: string) => SiteAdapter;

export const SITE_KINDS: Record<string, SiteAdapterFactory> = {
	gate: (config, route, carried) => new GateSite(config, route, carried),
};
