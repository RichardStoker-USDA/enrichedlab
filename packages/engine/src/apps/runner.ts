// The runner for "bun" app backends. The engine writes it next to its state and starts it on the Bun runtime inside
// EnrichedLab (the compiled binary acts as `bun` with BUN_BE_BUN=1), so a backend needs nothing installed.
//
// A backend module exports its tools:
//
//   export const tools = {
//     mean_yield: {
//       description: "Mean yield by treatment",
//       input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
//       async run({ path }, app) { return { text: "…", data: { … } }; },
//     },
//   };
//
// `run` returns a string, { text, data } (data becomes structuredContent), or a full MCP CallToolResult. `app` holds
// dataDir (the app's writable folder), projectDir and log (to stderr). The runner serves the tools as an MCP server
// on stdio and answers both handshakes: initialize (2025-11-25) and server/discover (2026-07-28).

export const RUNNER_SOURCE = String.raw`
import { pathToFileURL } from "node:url";

// stdout carries the protocol; anything a backend prints goes to stderr.
console.log = (...args) => console.error(...args);

const VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const info = { name: process.env.APP_NAME || "app", version: process.env.APP_VERSION || "0.0.0" };
const app = { dataDir: process.env.APP_DATA_DIR, projectDir: process.env.PROJECT_DIR, log: (...args) => console.error(...args) };

const mod = await import(pathToFileURL(process.argv[2]).href);
const tools = mod.tools ?? mod.default?.tools ?? {};

function listed() {
	return Object.entries(tools).map(([name, tool]) => ({
		name,
		description: tool.description ?? name,
		inputSchema: tool.input ?? tool.inputSchema ?? { type: "object", properties: {} },
		...(tool.annotations ? { annotations: tool.annotations } : {}),
		...(tool.visibility ? { _meta: { ui: { visibility: tool.visibility } } } : {}),
	}));
}

function asResult(value) {
	if (value && typeof value === "object" && Array.isArray(value.content)) return value;
	if (typeof value === "string") return { content: [{ type: "text", text: value }] };
	if (value === undefined || value === null) return { content: [] };
	const { text, data, ...rest } = value;
	const structured = data ?? rest;
	return { content: [{ type: "text", text: text ?? JSON.stringify(structured) }], structuredContent: structured };
}

function failure(code, message) {
	return Object.assign(new Error(message), { code });
}

async function answer(method, params) {
	switch (method) {
		case "initialize":
			return { protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : "2025-11-25", capabilities: { tools: {} }, serverInfo: info };
		case "server/discover":
			return { supportedVersions: VERSIONS, capabilities: { tools: {} }, serverInfo: info };
		case "ping":
			return {};
		case "tools/list":
			return { tools: listed() };
		case "tools/call": {
			const tool = tools[params?.name];
			if (!tool || typeof tool.run !== "function") throw failure(-32602, "No tool named " + params?.name + ".");
			try {
				return asResult(await tool.run(params.arguments ?? {}, app));
			} catch (error) {
				return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
			}
		}
		default:
			throw failure(-32601, "Unknown method " + method + ".");
	}
}

const write = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of process.stdin) {
	buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
	let newline;
	while ((newline = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id === undefined || typeof message.method !== "string") continue;
		answer(message.method, message.params).then(
			(result) => write({ jsonrpc: "2.0", id: message.id, result }),
			(error) => write({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: String(error.message ?? error) } }),
		);
	}
}
`;
