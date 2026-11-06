// A desktop sandbox at a lab (docs/research.md, contract/desktop.schema.json): a Linux desktop the person and the
// agent both work in, through one checked action at a time (POST /v1/containers/{id}/desktop). The lab gives a
// desktop sandbox no shell, attach, jobs or ports, so those actions are the only way in, and it audits each one.

import type { DesktopFrame } from "@enrichedlab/protocol";
import type { DesktopInfo } from "./contract.ts";
import type { Tool } from "../tools/types.ts";
import { ToolError } from "../tools/types.ts";
import { clip } from "../util.ts";

/** The actions this client knows, in the computer-use vocabulary models are trained on. */
export const DESKTOP_ACTIONS = ["screenshot", "cursor_position", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "type", "key", "scroll", "zoom", "wait"] as const;
export type DesktopActionName = (typeof DESKTOP_ACTIONS)[number];

export interface DesktopAction {
	action: DesktopActionName;
	coordinate?: [number, number];
	start_coordinate?: [number, number];
	text?: string;
	scroll_direction?: "up" | "down" | "left" | "right";
	scroll_amount?: number;
	region?: [number, number, number, number];
	duration?: number;
}

export type { DesktopFrame };

export interface DesktopResult {
	frame?: DesktopFrame;
	cursor?: [number, number];
}

/** What a lab's adapter gives for its desktop sandbox. */
export interface DesktopApi {
	desktop(): DesktopInfo | undefined;
	desktopAct(action: DesktopAction, by: "agent" | "person", signal?: AbortSignal): Promise<DesktopResult>;
	desktopOpen(target: string, by: "agent" | "person", signal?: AbortSignal): Promise<DesktopResult>;
}

const TYPE_MAX = 4_000;
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

/** Check an action before it goes to the lab, with the reason a model can act on. */
export function checkAction(raw: Record<string, unknown>, info: DesktopInfo): DesktopAction {
	const action = String(raw.action ?? "") as DesktopActionName;
	if (!DESKTOP_ACTIONS.includes(action)) throw new ToolError(`action must be one of: ${DESKTOP_ACTIONS.join(", ")}.`);
	if (info.actions.length && !info.actions.includes(action)) throw new ToolError(`This desktop doesn't take ${action}. It takes: ${info.actions.join(", ")}.`);
	const out: DesktopAction = { action };
	const round = (p: [number, number]): [number, number] => [Math.round(p[0]), Math.round(p[1])];
	if (raw.coordinate !== undefined) {
		if (!isPoint(raw.coordinate)) throw new ToolError("coordinate is [x, y] in screen pixels.");
		out.coordinate = round(raw.coordinate);
	}
	if (raw.start_coordinate !== undefined) {
		if (!isPoint(raw.start_coordinate)) throw new ToolError("start_coordinate is [x, y] in screen pixels.");
		out.start_coordinate = round(raw.start_coordinate);
	}
	const screen = info.screen;
	for (const p of [out.coordinate, out.start_coordinate]) {
		if (p && screen && (p[0] >= screen.width || p[1] >= screen.height)) throw new ToolError(`[${p.join(", ")}] is off the screen, which is ${screen.width} by ${screen.height}.`);
	}
	if ((action === "mouse_move" || action === "left_click_drag" || action === "scroll") && !out.coordinate) throw new ToolError(`${action} needs coordinate.`);
	if (action === "left_click_drag" && !out.start_coordinate) throw new ToolError("left_click_drag needs start_coordinate and coordinate.");
	if (action === "type" || action === "key") {
		if (typeof raw.text !== "string" || !raw.text) throw new ToolError(`${action} needs text.`);
		if (raw.text.length > TYPE_MAX) throw new ToolError(`Type at most ${TYPE_MAX} characters at a time.`);
		out.text = raw.text;
	}
	if (action === "scroll") {
		const direction = String(raw.scroll_direction ?? "down");
		if (!["up", "down", "left", "right"].includes(direction)) throw new ToolError("scroll_direction is up, down, left or right.");
		out.scroll_direction = direction as DesktopAction["scroll_direction"];
		out.scroll_amount = Math.max(1, Math.min(50, Math.round(Number(raw.scroll_amount ?? 3)) || 3));
	}
	if (action === "zoom") {
		const r = raw.region;
		if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number" && n >= 0)) throw new ToolError("zoom needs region: [x0, y0, x1, y1].");
		out.region = r.map(Math.round) as [number, number, number, number];
	}
	if (action === "wait") out.duration = Math.max(0, Math.min(30, Number(raw.duration ?? 1) || 1));
	return out;
}

/** The screenshot in a lab's answer, whichever of the usual names it uses. */
export function frameIn(answer: unknown, site: string, by: "agent" | "person", info?: DesktopInfo): DesktopFrame | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const a = answer as Record<string, unknown>;
	const shot = (typeof a.screenshot === "object" && a.screenshot ? a.screenshot : a) as Record<string, unknown>;
	const png = [shot.png, shot.data, shot.image, shot.base64_image].find((v): v is string => typeof v === "string" && v.length > 0);
	if (!png) return undefined;
	const width = Number(shot.width ?? info?.screen?.width ?? 0);
	const height = Number(shot.height ?? info?.screen?.height ?? 0);
	return { site, png: png.replace(/^data:image\/png;base64,/, ""), width, height, by, at: new Date().toISOString() };
}

/** What happened, in words, for the step line and the model. */
function said(a: DesktopAction): string {
	const at = a.coordinate ? ` at (${a.coordinate.join(", ")})` : "";
	switch (a.action) {
		case "type":
			return `Typed ${a.text!.length} character${a.text!.length === 1 ? "" : "s"}.`;
		case "key":
			return `Pressed ${a.text}.`;
		case "left_click_drag":
			return `Dragged from (${a.start_coordinate!.join(", ")}) to (${a.coordinate!.join(", ")}).`;
		case "scroll":
			return `Scrolled ${a.scroll_direction} ${a.scroll_amount}${at}.`;
		case "wait":
			return `Waited ${a.duration} s.`;
		case "screenshot":
			return "Took a screenshot.";
		case "zoom":
			return `Zoomed into (${a.region!.join(", ")}).`;
		case "cursor_position":
			return "Read the pointer's position.";
		default:
			return `${a.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}${at}.`;
	}
}

/** The agent's desktop tools for one lab. They act only inside the lab's desktop sandbox. */
export function desktopTools(site: string, title: string, api: DesktopApi): Tool[] {
	const info = api.desktop();
	if (!info) return [];
	const size = info.screen ? `${info.screen.width} by ${info.screen.height} pixels` : "the size its screenshot shows";
	const actions = info.actions.length ? DESKTOP_ACTIONS.filter((a) => info.actions.includes(a)) : [...DESKTOP_ACTIONS];
	const desktop: Tool = {
		name: `${site}_desktop`,
		kind: "sandbox",
		description: `Use the Linux desktop in your ${title} sandbox, ${size}: for programs that only have a window (RStudio, a PDF form, a viewer). Start with a screenshot; coordinates are pixels on that screenshot. Every action answers with a new screenshot. Typing takes at most ${TYPE_MAX} characters; key takes names like Return, Tab, ctrl+s. The person can watch and use the same desktop. It has no shell: use ${site}_sandbox_run in your other sandbox for commands.`,
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: actions },
				coordinate: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "[x, y] for clicks, moves, drags (the end) and scrolling" },
				start_coordinate: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2, description: "[x, y] where a drag starts" },
				text: { type: "string", description: "type: the text; key: a key or chord such as Return or ctrl+s" },
				scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
				scroll_amount: { type: "integer", minimum: 1, maximum: 50 },
				region: { type: "array", items: { type: "integer" }, minItems: 4, maxItems: 4, description: "zoom: [x0, y0, x1, y1]" },
				duration: { type: "number", minimum: 0, maximum: 30, description: "wait: seconds" },
			},
			required: ["action"],
		},
		view: (args) => {
			const a = args as Partial<DesktopAction>;
			const target = a.action === "type" ? `${String(a.text ?? "").length} characters` : a.action === "key" ? String(a.text ?? "") : a.coordinate ? `(${a.coordinate.join(", ")})` : "";
			return { verb: `desktop ${String(a.action ?? "").replace(/_/g, " ")}`, target: clip(target, 80) };
		},
		async run(args, ctx) {
			const action = checkAction(args, info);
			const result = await api.desktopAct(action, "agent", ctx.signal);
			const parts = [said(action)];
			if (result.cursor) parts.push(`The pointer is at (${result.cursor.join(", ")}).`);
			const frame = result.frame;
			if (frame && !ctx.vision) parts.push("This model can't see images, so the screenshot shows only in the person's desktop pane.");
			return { ok: true, content: parts.join(" "), images: frame && ctx.vision ? [{ type: "image", mime: "image/png", data: frame.png }] : undefined, view: { result: said(action) } };
		},
	};
	if (!info.open) return [desktop];
	const open: Tool = {
		name: `${site}_desktop_open`,
		kind: "sandbox",
		description: `Open an https address or a file under /sandbox on the ${title} desktop, in the program that opens it.`,
		parameters: { type: "object", properties: { target: { type: "string", description: "an https address, or a /sandbox/... file" } }, required: ["target"] },
		view: (args) => ({ verb: "desktop open", target: clip(String(args.target ?? ""), 120) }),
		async run(args, ctx) {
			const target = String(args.target ?? "").trim();
			if (!/^https:\/\//.test(target) && !target.startsWith("/sandbox/")) throw new ToolError("target is an https address or a /sandbox/... file.");
			const result = await api.desktopOpen(target, "agent", ctx.signal);
			return { ok: true, content: `Opened ${target}.`, images: result.frame && ctx.vision ? [{ type: "image", mime: "image/png", data: result.frame.png }] : undefined };
		},
	};
	return [desktop, open];
}
