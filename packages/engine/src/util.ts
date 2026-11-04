import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const VERSION = "0.2.2";

/** What changed in this version, one line each, newest first. Surfaces show the first lines when a session opens. */
export const NEWS = [
	"0.2.2: at labs that ask for it, requests are bound to this computer with a device key kept in the OS credential store; web apps in a lab sandbox (Shiny, Streamlit) open in the browser pane.",
	"0.2.1: el lab check tests a lab against the lab contract; lab events show as notices; lab files save into your project with their checksum checked.",
	"0.2: the terminal command is now el (el app, el run, el login); settings moved from ~/.enriched to ~/.el.",
	"Use your ChatGPT plan: Continue with ChatGPT under Model services, or el service add chatgpt.",
	"0.1.1: Windows commands write only to the project; a quieter start; fixes found by testing on all three systems.",
	"Ask for an app and the agent builds one that runs beside the session, R and Python Shiny included.",
	"The agent can use the built-in browser, where your sign-ins persist, and fill PDF forms.",
	"Add your own OpenAI, Anthropic or Gemini key, or join a lab from its invite link.",
	"Signed installers for macOS, Windows and Linux, with no administrator; updates install the same way.",
];

/** Sortable, unique enough for one person's sessions and events: time then randomness. */
export function newId(prefix = ""): string {
	const time = Date.now().toString(36).padStart(9, "0");
	return `${prefix}${time}${randomBytes(5).toString("hex")}`;
}

export const now = (): string => new Date().toISOString();

/** `~` and `~/…` mean the home folder. Nothing else is changed. */
export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
	return path;
}

export function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** Write a whole file through a temporary name so a reader never sees half of it. `secret` makes it owner-only. */
export function writeFileAtomic(path: string, data: string, secret = false): void {
	mkdirSync(dirname(path), { recursive: true, mode: secret ? 0o700 : 0o755 });
	const temp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(temp, data, { mode: secret ? 0o600 : 0o644 });
	if (secret) chmodSync(temp, 0o600);
	renameSync(temp, path);
}

export const writeJson = (path: string, value: unknown, secret = false): void =>
	writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, secret);

/** Read a secret named by a file path or an environment variable, at the moment of use. */
export function readSecret(ref: { keyFile?: string; keyEnv?: string }): string | undefined {
	if (ref.keyEnv && process.env[ref.keyEnv]) return process.env[ref.keyEnv]!.trim();
	if (ref.keyFile) {
		try {
			return readFileSync(expandHome(ref.keyFile), "utf8").trim();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Rough token count for text the provider hasn't counted yet. Code and prose average near 3.6 characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export function errorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Remove anything that looks like a bearer token or key from text that may reach a log or a surface. */
export function redact(text: string): string {
	return text
		.replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[redacted]")
		.replace(/\b(gate_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, "[redacted]");
}

export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** A tiny typed event emitter. */
export class Emitter<T extends Record<string, unknown>> {
	private listeners = new Map<keyof T, Set<(value: never) => void>>();
	on<K extends keyof T>(name: K, listener: (value: T[K]) => void): () => void {
		let set = this.listeners.get(name);
		if (!set) this.listeners.set(name, (set = new Set()));
		set.add(listener as (value: never) => void);
		return () => set!.delete(listener as (value: never) => void);
	}
	emit<K extends keyof T>(name: K, value: T[K]): void {
		for (const listener of this.listeners.get(name) ?? []) (listener as (value: T[K]) => void)(value);
	}
}

/** File names that usually hold secrets: never uploaded to a site, never sent in a repository handoff. */
export const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|.*\.pem|.*\.key|id_[a-z0-9]+|credentials(\.json)?|.*\.tfstate|\.netrc|\.npmrc|\.pypirc)$/i;
