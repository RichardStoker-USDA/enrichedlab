// The Responses API adapter against a local server that streams the events OpenAI documents: reasoning summaries,
// text, a namespaced function call, and the completed usage. Then the replay and the plan's usage-limit error.

import { afterAll, describe, expect, test } from "bun:test";
import { responsesAdapter, TOOL_NAMESPACE } from "../packages/engine/src/models/openai_responses.ts";
import type { ModelProfile, ModelRequest, StreamEvent } from "../packages/engine/src/models/types.ts";

const bodies: Record<string, unknown>[] = [];
let mode: "answer" | "limit" = "answer";

const sse = (events: Record<string, unknown>[]) =>
	new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		bodies.push((await request.json()) as Record<string, unknown>);
		if (mode === "limit") {
			return Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }, { status: 429 });
		}
		return sse([
			{ type: "response.created", response: { id: "resp_1" } },
			{ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
			{ type: "response.reasoning_summary_part.added", output_index: 0 },
			{ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "Looking at the file." },
			{ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Looking at the file." }], encrypted_content: "opaque" } },
			{ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant" } },
			{ type: "response.output_text.delta", output_index: 1, delta: "Reading " },
			{ type: "response.output_text.delta", output_index: 1, delta: "it now." },
			{ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Reading it now." }] } },
			{ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "read", namespace: TOOL_NAMESPACE } },
			{ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"path":' },
			{ type: "response.function_call_arguments.delta", output_index: 2, delta: '"a.txt"}' },
			{ type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_a", name: "read", namespace: TOOL_NAMESPACE, arguments: '{"path":"a.txt"}' } },
			{ type: "response.completed", response: { usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 12 } } } },
		]);
	},
});
afterAll(() => server.stop(true));

const model: ModelProfile = {
	ref: "chatgpt/gpt-test",
	provider: "chatgpt",
	id: "gpt-test",
	label: "test",
	source: "config",
	api: "openai-responses",
	baseUrl: `http://127.0.0.1:${server.port}/v1`,
	context: 200_000,
	maxOutput: 128_000,
	vision: true,
	efforts: ["low", "medium", "high"],
	defaultEffort: "medium",
	effortField: "none",
	replayReasoning: true,
	headers: async () => ({ authorization: "Bearer test" }),
	toolNamespace: TOOL_NAMESPACE,
};

const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
	model,
	system: "Be brief.",
	messages: [{ role: "user", content: [{ type: "text", text: "What's in a.txt?" }] }],
	tools: [{ name: "read", description: "Read a file.", parameters: { type: "object", properties: { path: { type: "string" } } } }],
	...extra,
});

async function collect(req: ModelRequest): Promise<StreamEvent[]> {
	const out: StreamEvent[] = [];
	for await (const event of responsesAdapter(TOOL_NAMESPACE).stream(req, new AbortController().signal)) out.push(event);
	return out;
}

describe("Responses API", () => {
	test("streams reasoning, text and a namespaced call; the request follows the plan route's rules", async () => {
		mode = "answer";
		const events = await collect(request());
		const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
		const reasoning = events.flatMap((e) => (e.type === "reasoning" ? [e.delta] : [])).join("");
		const args = events.flatMap((e) => (e.type === "tool_args" ? [e.delta] : [])).join("");
		expect({ text, reasoning, args }).toEqual({ text: "Reading it now.", reasoning: "Looking at the file.", args: '{"path":"a.txt"}' });
		expect(events.find((e) => e.type === "tool_start")).toEqual({ type: "tool_start", index: 0, id: "call_a", name: "read" });
		expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", usage: { input: 120, output: 30, cached: 100, reasoning: 12 } });
		expect(events.at(-1)).toEqual({ type: "done", stop: "tool_use" });

		const body = bodies.at(-1)!;
		expect(body).toMatchObject({ model: "gpt-test", store: false, stream: true, instructions: "Be brief.", include: ["reasoning.encrypted_content"] });
		expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
		const tools = body.tools as { type: string; name: string; tools: { name: string }[] }[];
		expect(tools.map((t) => [t.type, t.name, t.tools.map((x) => x.name)])).toEqual([["namespace", TOOL_NAMESPACE, ["read"]]]);
		for (const field of ["max_output_tokens", "temperature", "previous_response_id", "metadata", "user"]) expect(body[field]).toBeUndefined();
		expect(JSON.stringify(body.input)).not.toContain('"role":"system"');

		// The next turn replays the output items without ids, then the call's result.
		const replay = events.find((e) => e.type === "reasoning_data") as { data: { responses: Record<string, unknown>[] } };
		await collect(
			request({
				messages: [
					{ role: "user", content: [{ type: "text", text: "What's in a.txt?" }] },
					{ role: "assistant", text, reasoningData: replay.data, toolCalls: [{ id: "call_a", name: "read", args }] },
					{ role: "tool", callId: "call_a", name: "read", content: "hello" },
				],
			}),
		);
		const input = bodies.at(-1)!.input as Record<string, unknown>[];
		expect(input.map((i) => i.type)).toEqual(["message", "reasoning", "message", "function_call", "function_call_output"]);
		expect(input.some((i) => "id" in i || "status" in i)).toBe(false);
		expect(input[1]).toMatchObject({ encrypted_content: "opaque" });
		expect(input[3]).toMatchObject({ call_id: "call_a", namespace: TOOL_NAMESPACE });
		expect(input[4]).toEqual({ type: "function_call_output", call_id: "call_a", output: "hello" });
	});

	test("a plan usage limit stops with a pointer to ChatGPT's usage settings and is not retried", async () => {
		mode = "limit";
		const error = await collect(request()).catch((e: unknown) => e as { message: string; retryable: boolean; status: number });
		expect(error).toMatchObject({ status: 429, retryable: false });
		expect((error as { message: string }).message).toContain("https://chatgpt.com/settings/usage");
	});
});

describe("Sign in with ChatGPT", () => {
	test("registers, checks the signed ID token, keeps tokens private, refreshes and signs out", async () => {
		const { mkdtempSync, readFileSync, rmSync, statSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const chatgpt = await import("../packages/engine/src/models/chatgpt.ts");
		const home = mkdtempSync(join(tmpdir(), "lab-chatgpt-"));
		const credentials = join(home, "credentials");
		const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
		const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
		let nonce = "";
		const sign = async (claims: Record<string, unknown>) => {
			const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
			const input = `${part({ alg: "RS256", kid: "k1" })}.${part(claims)}`;
			const signature = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input))).toString("base64url");
			return `${input}.${signature}`;
		};
		const forms: Record<string, string>[] = [];
		let refreshes = 0;
		const fake = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/.well-known/openid-configuration")) return Response.json({ jwks_uri: "https://auth.example/jwks", revocation_endpoint: "https://auth.example/revoke" });
			if (url === "https://auth.example/jwks") return Response.json({ keys: [jwk] });
			const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? "")));
			forms.push(form);
			if (url === "https://auth.example/revoke") return new Response("", { status: 200 });
			if (form.grant_type === "refresh_token") {
				refreshes++;
				return Response.json({ access_token: `access_${refreshes + 1}`, refresh_token: `refresh_${refreshes + 1}`, expires_in: 3600, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke" });
			}
			const id_token = await sign({ iss: "https://auth.openai.com", aud: "oaiapp_test", sub: "user-1", email: "person@example.org", nonce, exp: Math.floor(Date.now() / 1000) + 600 });
			return Response.json({ access_token: "access_1", refresh_token: "refresh_1", id_token, expires_in: 1, scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke" });
		}) as typeof fetch;

		const signedIn = await chatgpt.signIn({
			home,
			credentials,
			fetchImpl: fake,
			open: (address) => {
				const url = new URL(address);
				expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
				expect(url.searchParams.get("agent_name_hint")).toBe("EnrichedLab");
				expect(url.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
				nonce = url.searchParams.get("nonce")!;
				const back = new URL(url.searchParams.get("redirect_uri")!);
				back.search = new URLSearchParams({ code: "c1", state: url.searchParams.get("state")!, client_id: "oaiapp_test" }).toString();
				void fetch(back);
			},
		});
		expect(signedIn.welcome).toBe(true);
		expect(forms[0]).toMatchObject({ grant_type: "authorization_code", client_id: "oaiapp_test", code: "c1", resource: "https://api.openai.com/v1" });
		expect(chatgpt.summaries(credentials)).toEqual([{ id: "oaiapp_test", label: "person@example.org", active: true, signedIn: true, plan: true }]);
		expect(statSync(join(credentials, "chatgpt.json")).mode & 0o777).toBe(0o600);

		// The first token expires at once: two callers share one refresh, and the rotated token is kept.
		const [a, b] = await Promise.all([chatgpt.accessToken(credentials, undefined, fake), chatgpt.accessToken(credentials, undefined, fake)]);
		expect([a, b, refreshes]).toEqual(["access_2", "access_2", 1]);
		expect(JSON.parse(readFileSync(join(credentials, "chatgpt.json"), "utf8")).accounts[0].refresh).toBe("refresh_2");

		// A second sign-in to the same account reuses its client id and says nothing new.
		const again = await chatgpt.signIn({
			home,
			credentials,
			account: "oaiapp_test",
			fetchImpl: fake,
			open: (address) => {
				const url = new URL(address);
				expect(url.searchParams.get("client_id")).toBe("oaiapp_test");
				expect(url.searchParams.get("agent_name_hint")).toBeNull();
				expect(url.searchParams.get("id_token_hint")).toBeTruthy();
				nonce = url.searchParams.get("nonce")!;
				const back = new URL(url.searchParams.get("redirect_uri")!);
				back.search = new URLSearchParams({ code: "c2", state: url.searchParams.get("state")! }).toString();
				void fetch(back);
			},
		});
		expect(again.welcome).toBe(false);

		expect(await chatgpt.signOut(credentials, "oaiapp_test", fake)).toEqual({ revoked: true });
		expect(forms.at(-1)).toMatchObject({ token_type_hint: "refresh_token", client_id: "oaiapp_test" });
		expect(chatgpt.summaries(credentials)).toEqual([{ id: "oaiapp_test", label: "person@example.org", active: false, signedIn: false, plan: false }]);
		rmSync(home, { recursive: true, force: true });
	});
});
