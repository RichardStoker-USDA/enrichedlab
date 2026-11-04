// The desktop app's browser, driven by the agent. Pages open in the workbench's browser pane, in the same browsing
// profile the person uses there, so sites they signed in to stay signed in. The engine asks the window to act; a
// session without the desktop window open has no browser. Reading and looking run; clicking and typing ask.

import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { str, ToolError } from "./types.ts";

async function act(ctx: ToolContext, op: string, args: Record<string, unknown>): Promise<ToolResult> {
	if (!ctx.surface) throw new ToolError("The browser is in the EnrichedLab app; open this session there (el app) and try again.");
	const answer = await ctx.surface.call("browser", op, args, ctx.signal);
	const images = answer.image && ctx.vision ? [{ type: "image" as const, mime: answer.image.mime, data: answer.image.data }] : undefined;
	return { ok: true, content: answer.text, images, view: { result: answer.text.split("\n")[0]?.slice(0, 120) } };
}

const READ_NOTE =
	"Returns the page as text: headings, text, and each control as [n] role \"name\" (value). Use n with browser_click and browser_type.";

export const browserOpenTool: Tool<{ url: string }> = {
	name: "browser_open",
	description: `Open a web page in the workbench's browser pane (the person's own browser profile, so sites they're signed in to stay signed in). ${READ_NOTE}`,
	parameters: { type: "object", properties: { url: { type: "string", description: "An http(s) address" } }, required: ["url"] },
	kind: "net",
	host: (args) => new URL(args.url).host,
	view: (args) => ({ verb: "Open", target: args.url }),
	run: (args, ctx) => {
		if (!/^https?:\/\//.test(args.url)) throw new ToolError("Give an http or https address.");
		return act(ctx, "open", { url: str(args, "url") });
	},
};

export const browserReadTool: Tool<Record<string, never>> = {
	name: "browser_read",
	description: `Read the page open in the browser pane again (after it changed). ${READ_NOTE}`,
	parameters: { type: "object", properties: {} },
	kind: "local",
	view: () => ({ verb: "Read", target: "the page" }),
	run: (_args, ctx) => act(ctx, "read", {}),
};

export const browserClickTool: Tool<{ ref: number; why?: string }> = {
	name: "browser_click",
	description: "Click a control on the open page by its number from browser_read or browser_open. Returns the page afterwards.",
	parameters: {
		type: "object",
		properties: { ref: { type: "integer" }, why: { type: "string", description: "What the click does, for the person approving it" } },
		required: ["ref"],
	},
	kind: "write",
	view: (args) => ({ verb: "Click", target: args.why ?? `control ${args.ref}` }),
	run: (args, ctx) => act(ctx, "click", { ref: args.ref }),
};

export const browserTypeTool: Tool<{ ref: number; text: string; submit?: boolean }> = {
	name: "browser_type",
	description: "Type into a field on the open page (replacing what's there), by its number; submit presses Enter afterwards.",
	parameters: {
		type: "object",
		properties: { ref: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean" } },
		required: ["ref", "text"],
	},
	kind: "write",
	view: (args) => ({ verb: "Type", target: `${args.text.length > 40 ? `${args.text.slice(0, 40)}…` : args.text} into control ${args.ref}${args.submit ? ", then Enter" : ""}` }),
	run: (args, ctx) => act(ctx, "type", { ref: args.ref, text: args.text, submit: args.submit === true }),
};

export const browserShotTool: Tool<Record<string, never>> = {
	name: "browser_screenshot",
	description: "A picture of the visible part of the open page, for models that can see images (layouts, charts, maps).",
	parameters: { type: "object", properties: {} },
	kind: "local",
	view: () => ({ verb: "Screenshot", target: "the page" }),
	run: (_args, ctx) => act(ctx, "shot", {}),
};

export const BROWSER_TOOLS = [browserOpenTool, browserReadTool, browserClickTool, browserTypeTool, browserShotTool] as Tool[];
