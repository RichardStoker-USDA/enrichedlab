// The seam every kind of site plugs into. A site signs a person in somewhere (Cloudflare Access, a LAN key) and
// grants them models, tools and a sandbox; an adapter turns one site's API into those. Gate is the first kind; the
// a research broker is the next kind. Add a kind by writing an adapter and registering it in SITE_KINDS.

import type { LabSandbox } from "@enrichedlab/protocol";
import type { BundleGrant } from "../bundles.ts";
import type { CheckRow, LabAppEntry, LabDescriptor, LabEvent, LabSigner } from "./contract.ts";
import type { ModelProfile } from "../models/types.ts";
import type { Tool } from "../tools/types.ts";
import { GateSite } from "./gate.ts";
import type { SandboxApi } from "./sandbox_workspace.ts";
import type { SiteConfig, SiteRoute } from "./sites.ts";

export interface SiteAdapter {
	/** Set by Sites: another device approved this computer's key, so connect again. */
	onApproved?: () => void;
	/** The person's devices at this lab, and approving or revoking one of them. */
	devices?(): Promise<{ id: string; name?: string; status?: string; created?: string; last_seen?: string; current?: boolean; thumbprint?: string }[]>;
	approveDevice?(id: string): Promise<void>;
	revokeDevice?(id: string): Promise<void>;
	/** The person's sandboxes at this lab, and deleting one; "deleting" while the lab still clears its files. */
	sandboxes?(): Promise<LabSandbox[]>;
	deleteSandbox?(id: string): Promise<"deleted" | "deleting">;
	/** Stop a running one, keeping its files; "stopping" while the lab still stops it. */
	stopSandbox?(id: string): Promise<"stopped" | "stopping" | "archived">;
	/** Make a new one from one of the lab's images and work in it from now on; the one before keeps its files. */
	createSandbox?(image?: string, network?: string): Promise<{ id: string; image?: string; network?: string; previous?: string }>;
	/** Apps the lab offers this person, withdrawn versions included (GET /v1/apps). */
	labApps?(): Promise<LabAppEntry[]>;
	/** Signers the lab vouches for, revoked ones included (GET /v1/signers). */
	signers?(): Promise<LabSigner[]>;
	/** One app package, checked against its listing. */
	appPackage?(entry: LabAppEntry, signal?: AbortSignal): Promise<Uint8Array>;
	/** Set by Sites: notices the adapter has for the person (a sandbox restored from its archive, or replaced). */
	onNotice?: (text: string) => void;
	/** On sign-out: revoke this computer's device key at the lab (best effort) and delete it here. */
	forget?(): Promise<void>;
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

export type SiteAdapterFactory = (config: SiteConfig, route: SiteRoute, carried?: string, deviceFile?: string) => SiteAdapter;

export const SITE_KINDS: Record<string, SiteAdapterFactory> = {
	gate: (config, route, carried, deviceFile) => new GateSite(config, route, carried, deviceFile),
};
