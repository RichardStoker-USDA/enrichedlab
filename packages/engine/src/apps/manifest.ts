// app.json: what an app is, what it runs, and what it may do. Everything else in the folder is the app's own files.
//
//   {
//     "name": "yield-explorer",                 lowercase, digits and dashes
//     "title": "Yield explorer",
//     "version": "0.1.0",
//     "description": "Explore plot yields by treatment",
//     "entry": "index.html",                     the page, relative to the folder
//     "backend": { "runtime": "bun", "main": "backend.ts" },
//     "permissions": { "files": "read", "models": true }
//   }
//
// Backends, all optional:
//   { "runtime": "bun", "main": "backend.ts" }                   a module on the Bun runtime inside EnrichedLab
//   { "runtime": "command", "command": ["uv", "run", "srv.py"] } any MCP server on stdio the person can run
//   { "runtime": "container", "image": "…", "build": "." }       an MCP server on stdio in a container
//   { "runtime": "serve", "command": ["Rscript", "app.R"] }      a web app (Shiny, Streamlit) on $PORT; the page is it

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { AppPermissions } from "@enrichedlab/protocol";

export type AppBackend =
	| { runtime: "bun"; main: string }
	| { runtime: "command"; command: string[] }
	| { runtime: "container"; image: string; build?: string; command?: string[] }
	| { runtime: "serve"; command: string[]; path?: string };

export interface AppManifest {
	name: string;
	title: string;
	version: string;
	description: string;
	entry: string;
	backend?: AppBackend;
	permissions: AppPermissions;
}

export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ORIGIN = /^(https|wss):\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;

/** A path inside the app folder: relative, no "..", no drive or root. */
function inside(path: unknown, what: string): string {
	if (typeof path !== "string" || !path || isAbsolute(path) || /^[a-z]:/i.test(path)) throw new Error(`${what} must be a path inside the app's folder.`);
	const clean = normalize(path).replaceAll("\\", "/");
	if (clean.startsWith("../") || clean === "..") throw new Error(`${what} must stay inside the app's folder.`);
	return clean;
}

function strings(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string" && v)) throw new Error(`${what} must be a list of words, such as ["Rscript", "app.R"].`);
	return value as string[];
}

function permissions(value: unknown): AppPermissions {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) throw new Error("permissions must be an object.");
	const p = value as Record<string, unknown>;
	const out: AppPermissions = {};
	if (p.files !== undefined) {
		if (p.files !== "read" && p.files !== "write") throw new Error('permissions.files is "read" or "write".');
		out.files = p.files;
	}
	if (p.commands === true) out.commands = true;
	if (p.models === true) out.models = true;
	if (p.labs !== undefined) out.labs = strings(p.labs, "permissions.labs");
	if (p.network !== undefined) {
		const list = p.network as unknown[];
		if (!Array.isArray(list) || !list.every((o) => typeof o === "string" && ORIGIN.test(o))) throw new Error('permissions.network lists origins such as "https://api.example.org".');
		out.network = list as string[];
	}
	return out;
}

function backend(value: unknown): AppBackend | undefined {
	if (value === undefined) return undefined;
	const b = value as Record<string, unknown>;
	switch (b?.runtime) {
		case "bun":
			return { runtime: "bun", main: inside(b.main, "backend.main") };
		case "command":
			return { runtime: "command", command: strings(b.command, "backend.command") };
		case "container": {
			if (typeof b.image !== "string" || !/^[a-z0-9][a-z0-9._/:@-]{0,254}$/i.test(b.image)) throw new Error("backend.image must be a container image name.");
			return { runtime: "container", image: b.image, build: b.build === undefined ? undefined : inside(b.build, "backend.build"), command: b.command === undefined ? undefined : strings(b.command, "backend.command") };
		}
		case "serve":
			return { runtime: "serve", command: strings(b.command, "backend.command"), path: typeof b.path === "string" ? b.path : undefined };
		default:
			throw new Error('backend.runtime is "bun", "command", "container" or "serve".');
	}
}

/** Read and check `<dir>/app.json`. Throws with a plain reason. */
export function readManifest(dir: string): AppManifest {
	const file = join(dir, "app.json");
	if (!existsSync(file)) throw new Error(`${dir} has no app.json.`);
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`app.json isn't valid JSON: ${(error as Error).message}`);
	}
	const name = raw.name;
	if (typeof name !== "string" || !APP_NAME.test(name)) throw new Error("app.json needs a name: lowercase letters, digits and dashes.");
	const manifest: AppManifest = {
		name,
		title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : name,
		version: typeof raw.version === "string" ? raw.version.slice(0, 40) : "0.0.0",
		description: typeof raw.description === "string" ? raw.description.slice(0, 400) : "",
		entry: raw.entry === undefined ? "index.html" : inside(raw.entry, "entry"),
		backend: backend(raw.backend),
		permissions: permissions(raw.permissions),
	};
	if (manifest.backend?.runtime !== "serve" && !existsSync(join(dir, manifest.entry))) throw new Error(`The app's page ${manifest.entry} is missing.`);
	return manifest;
}

/** The permissions in a stable form, so a grant can be matched to exactly what was allowed. */
export function permissionKey(p: AppPermissions): string {
	return JSON.stringify({ files: p.files ?? null, commands: !!p.commands, models: !!p.models, labs: [...(p.labs ?? [])].sort(), network: [...(p.network ?? [])].sort() });
}

/** Plain sentences for the consent card and the CLI. */
export function describePermissions(p: AppPermissions): string[] {
	const out: string[] = [];
	if (p.files === "read") out.push("Read files in the project");
	if (p.files === "write") out.push("Read and change files in the project");
	if (p.commands) out.push("Run commands where the session works, contained like the agent's");
	if (p.models) out.push("Ask the session's model");
	for (const lab of p.labs ?? []) out.push(`Run commands in the ${lab} sandbox`);
	for (const origin of p.network ?? []) out.push(`Reach ${origin}`);
	return out;
}
