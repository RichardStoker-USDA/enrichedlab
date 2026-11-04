// Bundles: add-ons that give a person skills, instructions, MCP servers, hooks and model settings in one install.
// A person adds them (`el bundle add <folder | https git address>`), or a site grants them after sign-in by
// the person's role. Two layouts are read:
//
//   bundle.json                  { "name", "version", "description", "skills": "skills", "instructions": "AGENTS.md",
//                                  "mcpServers": {…}, "hooks": {…}, "models": {…} }
//   .claude-plugin/plugin.json   the Claude Code plugin layout: skills/, .mcp.json, hooks/hooks.json
//
// Paths and commands may use ${BUNDLE_ROOT} (or the plugin layout's ${CLAUDE_PLUGIN_ROOT}). Bundles never change
// permissions. A site's bundle can't run anything on the person's computer: its hooks and command-started MCP
// servers are dropped, and an isolated site's bundle applies only to sessions bound to that site.
// See docs/bundles.md.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { LabConfig, McpServerConfig, ModelOverride } from "./config.ts";
import type { HookConfig, Hooks } from "./hooks.ts";
import type { Paths } from "./paths.ts";
import { readJson, writeJson } from "./util.ts";

export interface BundleContents {
	name: string;
	version: string;
	description: string;
	/** Absolute folders and files inside the bundle. */
	skills?: string;
	instructions?: string;
	mcpServers: Record<string, McpServerConfig>;
	hooks: Hooks;
	models: Record<string, ModelOverride>;
}

export interface InstalledBundle {
	name: string;
	version: string;
	description: string;
	dir: string;
	/** Where it came from: a folder, a git address, or "site:<name>". */
	source: string;
	/** sha256 over the bundle's files, taken at install. */
	sha256: string;
	installed: string;
}

/** A bundle a site grants: its files, small and text or base64. */
export interface BundleGrant {
	name: string;
	version: string;
	files: { path: string; content: string; base64?: boolean }[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const GRANT_MAX_BYTES = 5 * 1024 * 1024;

/** Read a bundle folder in either layout. Throws when it is neither. */
export function readBundle(dir: string): BundleContents {
	const root = resolve(dir);
	const fill = (value: string) => {
		const out = value.replaceAll("${BUNDLE_ROOT}", root).replaceAll("${CLAUDE_PLUGIN_ROOT}", root);
		// A path under the bundle uses this system's separators.
		return out !== value && out.startsWith(root) ? normalize(out) : out;
	};
	// Fill each string where it sits: a Windows path's backslashes would break the JSON text if filled there.
	const filled = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? {}), (_key, v) => (typeof v === "string" ? fill(v) : v));
	const inside = (path: string | undefined) => {
		if (!path) return undefined;
		const full = resolve(root, fill(path));
		return full === root || full.startsWith(`${root}/`) || full.startsWith(`${root}\\`) ? full : undefined;
	};
	const own = join(root, "bundle.json");
	const plugin = join(root, ".claude-plugin", "plugin.json");
	if (existsSync(own)) {
		const m = readJson<Record<string, unknown>>(own, {});
		const skills = inside(typeof m.skills === "string" ? m.skills : "skills");
		const instructions = inside(typeof m.instructions === "string" ? m.instructions : undefined);
		return {
			name: String(m.name ?? ""),
			version: String(m.version ?? "0"),
			description: String(m.description ?? ""),
			skills: skills && existsSync(skills) ? skills : undefined,
			instructions: instructions && existsSync(instructions) ? instructions : undefined,
			mcpServers: filled(m.mcpServers as Record<string, McpServerConfig>),
			hooks: filled(m.hooks as Hooks),
			models: (m.models as Record<string, ModelOverride>) ?? {},
		};
	}
	if (existsSync(plugin)) {
		const m = readJson<Record<string, unknown>>(plugin, {});
		const skills = join(root, "skills");
		const mcp = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(join(root, ".mcp.json"), {});
		const hooks = readJson<{ hooks?: Record<string, { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[]> }>(
			join(root, "hooks", "hooks.json"),
			{},
		);
		return {
			name: String(m.name ?? ""),
			version: String(m.version ?? "0"),
			description: String(m.description ?? ""),
			skills: existsSync(skills) ? skills : undefined,
			instructions: undefined,
			mcpServers: filled(mcp.mcpServers ?? {}),
			hooks: filled({ beforeTool: pluginHooks(hooks.hooks?.PreToolUse), afterTool: pluginHooks(hooks.hooks?.PostToolUse) }),
			models: {},
		};
	}
	throw new Error(`${dir} has neither bundle.json nor .claude-plugin/plugin.json.`);
}

/** The plugin layout names tools its own way; map the common ones onto ours. */
const PLUGIN_TOOL_NAMES: Record<string, string> = { Bash: "shell", Write: "write", Edit: "edit", MultiEdit: "edit", Read: "read", Grep: "grep", Glob: "glob", WebFetch: "fetch", WebSearch: "web_search" };

function pluginHooks(entries: { matcher?: string; hooks?: { type?: string; command?: string; timeout?: number }[] }[] | undefined): HookConfig[] {
	const out: HookConfig[] = [];
	for (const entry of entries ?? []) {
		const match = entry.matcher ? entry.matcher.replace(/[A-Za-z]+/g, (word) => PLUGIN_TOOL_NAMES[word] ?? word) : undefined;
		for (const hook of entry.hooks ?? []) if (hook.type === "command" && hook.command) out.push({ match, command: hook.command, timeout: hook.timeout });
	}
	return out;
}

/** sha256 over every file's relative path and bytes, in a fixed order. */
export function hashFolder(dir: string): string {
	const hash = createHash("sha256");
	const walk = (folder: string) => {
		for (const name of readdirSync(folder).sort()) {
			if (name === ".git") continue;
			const full = join(folder, name);
			if (statSync(full).isDirectory()) walk(full);
			else hash.update(`${relative(dir, full)}\0`).update(readFileSync(full));
		}
	};
	walk(dir);
	return hash.digest("hex");
}

function index(p: Paths): Record<string, InstalledBundle> {
	return readJson<Record<string, InstalledBundle>>(p.bundleIndex, {});
}

export function listBundles(p: Paths): InstalledBundle[] {
	return Object.values(index(p)).sort((a, b) => a.name.localeCompare(b.name));
}

/** Install from a folder or an https git address; a newer copy replaces the old one. */
export function installBundle(p: Paths, source: string): InstalledBundle {
	mkdirSync(p.bundles, { recursive: true, mode: 0o700 });
	const staging = join(p.bundles, `.incoming-${process.pid}-${Date.now().toString(36)}`);
	try {
		if (/^https:\/\//.test(source)) {
			execFileSync("git", ["clone", "-q", "--depth", "1", source, staging], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
			rmSync(join(staging, ".git"), { recursive: true, force: true });
		} else {
			const from = resolve(source);
			if (!existsSync(from) || !statSync(from).isDirectory()) throw new Error(`${source} isn't a folder or an https git address.`);
			cpSync(from, staging, { recursive: true, filter: (path) => !path.split(/[\\/]/).includes(".git") });
		}
		const contents = readBundle(staging);
		if (!NAME.test(contents.name)) throw new Error(`Bundle name "${contents.name}" must be lowercase letters, digits, dots, dashes or underscores.`);
		return place(p, staging, contents, /^https:\/\//.test(source) ? source : resolve(source));
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Write what a site granted under bundles/site-<site>/ and drop that site's grants it no longer lists. */
export function syncSiteBundles(p: Paths, site: string, grants: BundleGrant[]): InstalledBundle[] {
	mkdirSync(p.bundles, { recursive: true, mode: 0o700 });
	const source = `site:${site}`;
	const kept = new Set<string>();
	const placed: InstalledBundle[] = [];
	for (const grant of grants) {
		if (!NAME.test(grant.name)) continue;
		const name = `${site}.${grant.name}`;
		const current = index(p)[name];
		const staging = join(p.bundles, `.incoming-${process.pid}-${Date.now().toString(36)}`);
		try {
			let bytes = 0;
			for (const file of grant.files) {
				const target = resolve(staging, file.path);
				if (isAbsolute(file.path) || (!target.startsWith(`${staging}/`) && !target.startsWith(`${staging}\\`))) throw new Error(`${site} granted a bundle file outside its folder: ${file.path}`);
				const data = file.base64 ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8");
				bytes += data.length;
				if (bytes > GRANT_MAX_BYTES) throw new Error(`${site}'s bundle ${grant.name} is over 5 MB.`);
				mkdirSync(dirname(target), { recursive: true });
				writeFileSync(target, data, { mode: 0o600 });
			}
			kept.add(name);
			if (current && current.sha256 === hashFolder(staging)) {
				placed.push(current);
				continue;
			}
			const contents = { ...readBundle(staging), name };
			placed.push(place(p, staging, contents, source));
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	for (const bundle of listBundles(p)) if (bundle.source === source && !kept.has(bundle.name)) removeBundle(p, bundle.name);
	return placed;
}

function place(p: Paths, staging: string, contents: BundleContents, source: string): InstalledBundle {
	const dir = join(p.bundles, contents.name);
	const sha256 = hashFolder(staging);
	rmSync(dir, { recursive: true, force: true });
	renameSync(staging, dir);
	const record: InstalledBundle = { name: contents.name, version: contents.version, description: contents.description, dir, source, sha256, installed: new Date().toISOString() };
	writeJson(p.bundleIndex, { ...index(p), [contents.name]: record });
	return record;
}

export function removeBundle(p: Paths, name: string): boolean {
	const all = index(p);
	const bundle = all[name];
	if (!bundle) return false;
	rmSync(bundle.dir, { recursive: true, force: true });
	delete all[name];
	writeJson(p.bundleIndex, all);
	return true;
}

/**
 * Add installed bundles to a configuration. The person's own settings win on any name both define. `isolated` lists
 * sites whose bundles apply only when `site` (the session's bound site) is that site.
 */
export function applyBundles(config: LabConfig, bundles: InstalledBundle[], isolated: string[] = [], site?: string): LabConfig {
	const out: LabConfig = {
		...config,
		mcpServers: { ...config.mcpServers },
		models: { ...config.models },
		skills: { dirs: [...config.skills.dirs] },
		instructions: { global: [...config.instructions.global] },
		hooks: { beforeTool: [...(config.hooks.beforeTool ?? [])], afterTool: [...(config.hooks.afterTool ?? [])] },
	};
	for (const bundle of bundles) {
		const from = bundle.source.startsWith("site:") ? bundle.source.slice(5) : undefined;
		if (from && isolated.includes(from) && from !== site) continue;
		let contents: BundleContents;
		try {
			contents = readBundle(bundle.dir);
		} catch {
			continue;
		}
		if (contents.skills) out.skills.dirs.push(contents.skills);
		if (contents.instructions) out.instructions.global.push(contents.instructions);
		for (const [name, server] of Object.entries(contents.mcpServers)) {
			// A site's bundle can point at servers but not start programs here.
			if (from && server.command) continue;
			if (!Object.hasOwn(out.mcpServers, name)) out.mcpServers[name] = server;
		}
		for (const [ref, override] of Object.entries(contents.models)) if (!Object.hasOwn(out.models, ref)) out.models[ref] = override;
		if (!from) {
			out.hooks.beforeTool!.push(...(contents.hooks.beforeTool ?? []));
			out.hooks.afterTool!.push(...(contents.hooks.afterTool ?? []));
		}
	}
	return out;
}
