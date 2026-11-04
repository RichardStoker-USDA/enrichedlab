// Summaries that replace older turns. The session's model writes them unless config names a summary model (a site
// can offer a small, fast one). Tool outputs are clipped inside the summary request so the request itself fits.

import { adapterFor } from "../models/registry.ts";
import type { ModelProfile, Msg, ToolSchema } from "../models/types.ts";
import { clip } from "../util.ts";
import { messageTokens } from "./context.ts";

const SUMMARY_SYSTEM = `You write handoff notes for a coding and research agent. The conversation you are given will be replaced by your note, so the next stretch of work must be able to continue from it without asking the person to repeat anything.`;

export const SUMMARY_REQUEST = `Write the handoff note for everything above. Use these sections, in this order, in Markdown:

## Goal
What the person asked for, in their words where the wording matters.

## Constraints and preferences
Rules, choices and corrections the person gave.

## Done
What is finished and how it was checked.

## In progress
What was happening when this note was written.

## Decisions
Choices made and the reason for each. Approaches that failed, with the error, so they are not retried.

## Files
Paths read, created or changed, one line each on what matters about them.

## Next steps
The exact next action first, then the rest.

Keep what the person said, asked for and decided close to their own words; condense your own explanations and reasoning to what they concluded or produced. Keep difficulties and how they were handled, options tried or set aside and why, and details that would be hard to reconstruct (names, numbers, dates, exact wording, links), even at the cost of length. Copy identifiers, paths, commands, numbers and error text exactly. If an earlier summary is above, merge it in; don't nest it. Leave out greetings and narration.

Do not call any tools while writing this note; respond with text only.`;

const TOOL_CLIP = 3_000;
const TEXT_CLIP = 12_000;

/** Shrink messages for the summary request: clip long outputs, drop images, then drop the oldest until it fits.
 * `dropped` counts the messages left out, so the note can say so. */
export function prepareForSummary(messages: Msg[], budgetTokens: number): { messages: Msg[]; dropped: number } {
	let out: Msg[] = messages.map((m) => {
		if (m.role === "tool") return { ...m, content: clip(m.content, TOOL_CLIP), images: undefined };
		if (m.role === "user")
			return { ...m, content: m.content.map((p) => (p.type === "text" ? { ...p, text: clip(p.text, TEXT_CLIP) } : { type: "text" as const, text: "[image]" })) };
		return { ...m, text: clip(m.text, TEXT_CLIP), reasoning: undefined, reasoningData: undefined };
	});
	const total = () => out.reduce((n, m) => n + messageTokens(m), 0);
	// Keep the first message (it may be the earlier summary) and drop from just after it.
	while (out.length > 2 && total() > budgetTokens) out = [out[0], ...out.slice(2)];
	// A leading tool result without its call confuses providers; drop orphans at the front.
	while (out.length > 1 && out[1].role === "tool") out = [out[0], ...out.slice(2)];
	return { messages: out, dropped: messages.length - out.length };
}

/** `tools` are the session's tools: a history with tool calls needs them defined (Anthropic refuses the request
 * otherwise), and `toolChoice: "none"` keeps the answer to text. */
export async function summarize(model: ModelProfile, messages: Msg[], signal: AbortSignal, tools: ToolSchema[] = []): Promise<string> {
	const room = Math.max(4_096, model.context - 12_000 - Math.ceil(JSON.stringify(tools).length / 3.6));
	const { messages: prepared, dropped } = prepareForSummary(messages, room);
	const note = dropped
		? `\n\n${dropped} of the oldest messages did not fit in this request and are not shown above. Say so under Done, so nobody assumes the note covers them.`
		: "";
	const request = {
		model,
		system: SUMMARY_SYSTEM,
		messages: [...prepared, { role: "user" as const, content: [{ type: "text" as const, text: SUMMARY_REQUEST + note }] }],
		tools: prepared.some((m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls?.length)) ? tools : [],
		toolChoice: "none" as const,
		// A short summary is the point; lowest reasoning the model takes.
		effort: model.efforts.includes("low") ? "low" : model.efforts[0],
		maxTokens: Math.min(8_192, model.maxOutput),
	};
	let text = "";
	for await (const event of adapterFor(model).stream(request, signal)) {
		if (event.type === "text") text += event.delta;
		if (event.type === "done" && event.stop === "error") throw new Error(event.error ?? "The summary request failed.");
	}
	text = text.trim();
	if (text.length < 40) throw new Error("The model returned an empty summary.");
	return text;
}
