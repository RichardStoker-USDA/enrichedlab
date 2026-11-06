// Model services a person signs in to with their own key. The key goes to the operating system's credential store
// (macOS Keychain, Windows Credential Manager, the Linux Secret Service), or to a private file under
// ~/.el/credentials where none is available. config.json records only where the key lives.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderPreset } from "@enrichedlab/protocol";
import type { ProviderConfig } from "../config.ts";

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: "openai",
		label: "OpenAI",
		api: "openai-chat",
		baseUrl: "https://api.openai.com/v1",
		keyUrl: "https://platform.openai.com/api-keys",
		note: "An API key from platform.openai.com. A ChatGPT plan doesn't include API use.",
	},
	{
		id: "anthropic",
		label: "Anthropic",
		api: "anthropic",
		baseUrl: "https://api.anthropic.com/v1",
		keyUrl: "https://console.anthropic.com/settings/keys",
		note: "An API key from the Claude Console. A Claude plan doesn't include API use.",
	},
	{
		id: "gemini",
		label: "Google Gemini",
		api: "openai-chat",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		keyUrl: "https://aistudio.google.com/apikey",
		note: "A key from Google AI Studio; the free tier works, with daily limits.",
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		api: "openai-chat",
		baseUrl: "https://openrouter.ai/api/v1",
		keyUrl: "https://openrouter.ai/settings/keys",
		note: "One key for many providers' models, billed by OpenRouter.",
	},
	{
		id: "custom",
		label: "Other (OpenAI-compatible)",
		api: "openai-chat",
		baseUrl: "",
		note: "Any server that speaks the OpenAI chat API: vLLM, a university gateway, a lab endpoint.",
	},
];

const SERVICE = "EnrichedLab";

/**
 * A provider's entry in the credential store, kept apart per engine home: a second home (a test, CI, another
 * profile through EL_HOME) never overwrites or removes the person's own key. The usual homes keep the plain name
 * their keys were saved under.
 */
export function keyAccount(credentials: string, name: string): string {
	const dir = resolve(credentials);
	const usual = [join(homedir(), ".el", "credentials"), join(homedir(), ".enriched", "credentials")];
	return usual.includes(dir) ? `provider:${name}` : `provider:${name}@${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`;
}

/** Store a provider's key; returns where it went. */
export async function storeKey(credentials: string, name: string, key: string): Promise<"keychain" | "file"> {
	try {
		await Bun.secrets.set({ service: SERVICE, name: keyAccount(credentials, name), value: key });
		return "keychain";
	} catch {
		writeFileSync(join(credentials, `provider_${name}.key`), key, { mode: 0o600 });
		return "file";
	}
}

/** A provider's key from wherever `storeKey` put it. */
export async function loadKey(credentials: string, name: string): Promise<string | undefined> {
	const file = join(credentials, `provider_${name}.key`);
	if (existsSync(file)) return readFileSync(file, "utf8").trim();
	try {
		return (await Bun.secrets.get({ service: SERVICE, name: keyAccount(credentials, name) })) ?? undefined;
	} catch {
		return undefined;
	}
}

export async function forgetKey(credentials: string, name: string): Promise<void> {
	rmSync(join(credentials, `provider_${name}.key`), { force: true });
	await Bun.secrets.delete({ service: SERVICE, name: keyAccount(credentials, name) }).catch(() => false);
}

/** Check a key by listing the service's models; throws with the service's answer when it's refused. */
export async function testProvider(provider: ProviderConfig, key: string): Promise<number> {
	const headers: Record<string, string> =
		provider.api === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` };
	const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
	if (!response.ok) throw new Error(`${provider.label ?? provider.baseUrl} refused the key (${response.status}): ${(await response.text()).slice(0, 200)}`);
	const body = (await response.json()) as { data?: unknown[]; models?: unknown[] };
	const models = body.data ?? body.models ?? [];
	if (!models.length) throw new Error(`${provider.label ?? provider.baseUrl} accepted the key but listed no models.`);
	return models.length;
}
