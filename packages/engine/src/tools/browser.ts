// The browser tools act in one of two browsers (lanes). The device lane is the desktop app's browser pane, in the
// person's own browsing profile, so sites they signed in to stay signed in; the engine asks the window to act. The
// sandbox lane is a headless browser in a lab's sandbox (sandbox_browser.ts): it has none of the person's sign-ins,
// reaches only what the lab's network policy allows, and keeps downloads in the sandbox; the window watches it as a
// screencast. A session keeps using the lane it used last. Reading and looking run; clicking and typing ask.

import type { SandboxNetwork } from "@enrichedlab/protocol";
import type { PageAnswer } from "../sites/sandbox_browser.ts";
import type { Tool, ToolContext, ToolResult } from "./types.ts";
import { str, ToolError } from "./types.ts";

type Where = "device" | "sandbox";

/** What the browser tools can reach for a session (ToolContext.browser). */
export interface BrowserLanes {
	/** A desktop window with its browser shows this session. */
	device(): boolean;
	/** Labs whose sandbox has a browser, with what each can reach. */
	labs(): { site: string; title: string; network?: SandboxNetwork; hosts?: string[] }[];
	/** The session's page in `site`'s sandbox browser. */
	page(site: string, signal: AbortSignal): Promise<{ open(url: string): Promise<PageAnswer>; read(): Promise<PageAnswer>; click(ref: number): Promise<PageAnswer>; type(ref: number, text: string, submit: boolean): Promise<PageAnswer>; shot(): Promise<PageAnswer> }>;
	last(): { where: Where; site?: string } | undefined;
	remember(where: Where, site?: string): void;
}

/** The first line of a sandbox-browser result: whose sandbox, and what it can reach. */
const laneNote = (lab: ReturnType<BrowserLanes["labs"]>[number]) =>
	lab.network === "none"
		? `[In ${lab.title}'s sandbox browser, which has no web access: only pages served inside the sandbox (http://localhost:<port>) open.]`
		: lab.network === "allowlist"
			? `[In ${lab.title}'s sandbox browser, which reaches only ${lab.hosts?.length ? lab.hosts.join(", ") : "the hosts the lab allows"}.]`
			: `[In ${lab.title}'s sandbox browser.]`;

/** Which browser a call goes to: the one asked for, else the one used last, else the desktop's when a window shows it. */
function lane(ctx: ToolContext, op: string, args: { where?: string; lab?: string }): { where: Where; site?: string } {
	const lanes = ctx.browser;
	const labs = lanes?.labs() ?? [];
	// A lab that keeps its data inside: only its own sandbox's browser.
	if (ctx.sealed) {
		if (!labs.some((l) => l.site === ctx.place)) throw new ToolError("This lab keeps its data inside, and its sandbox has no browser.");
		return { where: "sandbox", site: ctx.place };
	}
	const last = lanes?.last();
	let where = (args.where === "device" || args.where === "sandbox" ? args.where : undefined) ?? (args.lab ? "sandbox" : undefined) ?? last?.where;
	where ??= op !== "open" || lanes?.device() || !labs.length ? "device" : "sandbox";
	if (where === "device") return { where };
	if (!labs.length) throw new ToolError("No lab you're signed in to has a browser in its sandbox; leave out where to use the desktop app's browser.");
	const named = args.lab ? labs.find((l) => l.site === args.lab || l.title.toLowerCase() === args.lab!.toLowerCase()) : undefined;
	if (args.lab && !named) throw new ToolError(`No lab named ${args.lab} has a sandbox browser. Labs with one: ${labs.map((l) => l.site).join(", ")}.`);
	const site = named?.site ?? labs.find((l) => l.site === ctx.place)?.site ?? (last?.where === "sandbox" ? last.site : undefined) ?? (labs.length === 1 ? labs[0]!.site : undefined);
	if (!site) throw new ToolError(`Say which lab's sandbox browser with lab: ${labs.map((l) => l.site).join(", ")}.`);
	return { where, site };
}

async function act(ctx: ToolContext, op: "open" | "read" | "click" | "type" | "shot", args: Record<string, unknown>): Promise<ToolResult> {
	const chosen = lane(ctx, op, args as { where?: string; lab?: string });
	let answer: PageAnswer;
	let prefix = "";
	if (chosen.where === "sandbox") {
		const lab = ctx.browser!.labs().find((l) => l.site === chosen.site)!;
		const page = await ctx.browser!.page(chosen.site!, ctx.signal);
		const ref = Number(args.ref);
		answer = await (op === "open" ? page.open(String(args.url)) : op === "read" ? page.read() : op === "click" ? page.click(ref) : op === "type" ? page.type(ref, String(args.text ?? ""), args.submit === true) : page.shot());
		prefix = `${laneNote(lab)}\n`;
	} else {
		if (!ctx.surface) throw new ToolError(`The browser is in the EnrichedLab app; open this session there (el app) and try again${ctx.browser?.labs().length ? ", or use where: sandbox" : ""}.`);
		const { where: _where, lab: _lab, ...rest } = args;
		answer = await ctx.surface.call("browser", op, rest, ctx.signal);
	}
	ctx.browser?.remember(chosen.where, chosen.site);
	const images = answer.image && ctx.vision ? [{ type: "image" as const, mime: answer.image.mime, data: answer.image.data }] : undefined;
	return { ok: true, content: prefix + answer.text, images, view: { result: answer.text.split("\n")[0]?.slice(0, 120) } };
}

const LANE = {
	where: {
		type: "string",
		enum: ["device", "sandbox"],
		description:
			"device: the desktop app's browser, with the person's own sign-ins. sandbox: a browser in a lab's sandbox, with no sign-ins, for research and pages served in the sandbox. Default: the one used last.",
	},
	lab: { type: "string", description: "Which lab's sandbox browser, when several have one." },
};

const READ_NOTE =
	"Returns the page as text: headings, text, and each control as [n] role \"name\" (value). Use n with browser_click and browser_type.";

export const browserOpenTool: Tool<{ url: string; where?: Where; lab?: string }> = {
	name: "browser_open",
	description: `Open a web page in the workbench's browser pane: the desktop app's browser (the person's own profile, so sites they're signed in to stay signed in), or with where: sandbox a lab sandbox's browser. ${READ_NOTE}`,
	parameters: { type: "object", properties: { url: { type: "string", description: "An http(s) address" }, ...LANE }, required: ["url"] },
	kind: "net",
	host: (args) => new URL(args.url).host,
	view: (args) => ({ verb: "Open", target: args.url }),
	run: (args, ctx) => {
		if (!/^https?:\/\//.test(args.url)) throw new ToolError("Give an http or https address.");
		return act(ctx, "open", { url: str(args, "url"), where: args.where, lab: args.lab });
	},
};

export const browserReadTool: Tool<{ where?: Where; lab?: string }> = {
	name: "browser_read",
	description: `Read the page open in the browser pane again (after it changed). ${READ_NOTE}`,
	parameters: { type: "object", properties: { ...LANE } },
	kind: "local",
	view: () => ({ verb: "Read", target: "the page" }),
	run: (args, ctx) => act(ctx, "read", { where: args.where, lab: args.lab }),
};

export const browserClickTool: Tool<{ ref: number; why?: string; where?: Where; lab?: string }> = {
	name: "browser_click",
	description: "Click a control on the open page by its number from browser_read or browser_open. Returns the page afterwards.",
	parameters: {
		type: "object",
		properties: { ref: { type: "integer" }, why: { type: "string", description: "What the click does, for the person approving it" }, ...LANE },
		required: ["ref"],
	},
	kind: "write",
	view: (args) => ({ verb: "Click", target: args.why ?? `control ${args.ref}` }),
	run: (args, ctx) => act(ctx, "click", { ref: args.ref, where: args.where, lab: args.lab }),
};

export const browserTypeTool: Tool<{ ref: number; text: string; submit?: boolean; where?: Where; lab?: string }> = {
	name: "browser_type",
	description: "Type into a field on the open page (replacing what's there), by its number; submit presses Enter afterwards.",
	parameters: {
		type: "object",
		properties: { ref: { type: "integer" }, text: { type: "string" }, submit: { type: "boolean" }, ...LANE },
		required: ["ref", "text"],
	},
	kind: "write",
	view: (args) => ({ verb: "Type", target: `${args.text.length > 40 ? `${args.text.slice(0, 40)}…` : args.text} into control ${args.ref}${args.submit ? ", then Enter" : ""}` }),
	run: (args, ctx) => act(ctx, "type", { ref: args.ref, text: args.text, submit: args.submit === true, where: args.where, lab: args.lab }),
};

export const browserShotTool: Tool<{ where?: Where; lab?: string }> = {
	name: "browser_screenshot",
	description: "A picture of the visible part of the open page, for models that can see images (layouts, charts, maps).",
	parameters: { type: "object", properties: { ...LANE } },
	kind: "local",
	view: () => ({ verb: "Screenshot", target: "the page" }),
	run: (args, ctx) => act(ctx, "shot", { where: args.where, lab: args.lab }),
};

export const BROWSER_TOOLS = [browserOpenTool, browserReadTool, browserClickTool, browserTypeTool, browserShotTool] as Tool[];
