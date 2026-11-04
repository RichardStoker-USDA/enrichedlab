// Provider-neutral messages and the adapter seam. An adapter turns these into one provider's wire format and its
// stream back into StreamEvents. Nothing above this file knows a provider's field names.

import type { ApiKind } from "../config.ts";
import type { Part, ToolCall, Usage } from "@enrichedlab/protocol";

export type Msg =
	| { role: "user"; content: Part[] }
	| { role: "assistant"; text: string; reasoning?: string; reasoningData?: unknown; toolCalls?: ToolCall[] }
	| { role: "tool"; callId: string; name: string; content: string; images?: Part[] };

export interface ToolSchema {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Everything known about how to talk to one model. */
export interface ModelProfile {
	ref: string;
	provider: string;
	id: string;
	label: string;
	source: "local" | "config" | "site";
	api: ApiKind;
	baseUrl: string;
	context: number;
	maxOutput: number;
	vision: boolean;
	efforts: string[];
	defaultEffort?: string;
	effortField: "reasoning_effort" | "chat_template_kwargs" | "none";
	replayReasoning: boolean;
	temperature?: number;
	instructions?: string;
	/** Returns request headers including credentials, read at the moment of use. */
	headers: () => Promise<Record<string, string>>;
	/** PEM text for a private CA, when the endpoint uses one. */
	ca?: string;
}

export interface ModelRequest {
	model: ModelProfile;
	system: string;
	messages: Msg[];
	tools: ToolSchema[];
	effort?: string;
	maxTokens?: number;
	/** "none" keeps the tools in the request (so the prefix and provider rules hold) but asks for text only. */
	toolChoice?: "auto" | "none";
}

export type StreamEvent =
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "reasoning_data"; data: unknown }
	| { type: "tool_start"; index: number; id: string; name: string }
	| { type: "tool_args"; index: number; delta: string }
	| { type: "usage"; usage: Usage }
	| { type: "done"; stop: "end" | "tool_use" | "length" | "error"; error?: string };

export interface ModelAdapter {
	stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent>;
}

/** An HTTP failure before the stream started. `retryable` covers rate limits, overload and network errors. */
export class ModelHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly retryable: boolean,
		readonly retryAfterMs?: number,
		readonly contextOverflow = false,
	) {
		super(message);
	}
}
