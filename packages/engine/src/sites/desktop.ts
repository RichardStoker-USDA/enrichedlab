// A desktop sandbox at a lab (docs/research.md, contract/desktop.schema.json): a Linux desktop the person and the
// agent both work in, through one checked action at a time (POST /v1/containers/{id}/desktop). The lab gives a
// desktop sandbox no shell, attach, jobs or ports, so those actions are the only way in, and it audits each one.

import type { DesktopFrame } from "@enrichedlab/protocol";
import type { DesktopInfo } from "./contract.ts";
import type { Tool } from "../tools/types.ts";
import { ToolError } from "../tools/types.ts";
import { clip, sleep } from "../util.ts";

/** How long after an input action the picture is taken: long enough for a menu or a dialog to draw. */
const SETTLE_MS = 400;

/** The actions this client knows, in the computer-use vocabulary models are trained on. */
export const DESKTOP_ACTIONS = ["state", "launch", "focus_window", "screenshot", "cursor_position", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "type", "key", "scroll", "zoom", "wait"] as const;
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
	/** focus_window: the window's id from state, such as 0x1a00003. */
	window?: string;
	/** launch: an app id from the desktop's list. */
	app?: string;
}

export type { DesktopFrame };

export interface DesktopStreamHandlers {
	band(band: { x: number; y: number; w: number; h: number; jpeg: Uint8Array }): void;
	end(reason: string): void;
}

export interface DesktopResult {
	frame?: DesktopFrame;
	cursor?: [number, number];
	/** The lab's whole answer, for state, launch and focus_window. */
	answer?: unknown;
}

/** What a lab's adapter gives for its desktop sandbox. */
export interface DesktopApi {
	desktop(): DesktopInfo | undefined;
	desktopAct(action: DesktopAction, by: "agent" | "person", signal?: AbortSignal): Promise<DesktopResult>;
	desktopOpen(target: string, by: "agent" | "person", signal?: AbortSignal, app?: string): Promise<DesktopResult>;
	/** The desktop's live view (where the lab streams it): changed bands of the screen until it ends. */
	desktopStream?(handlers: DesktopStreamHandlers, signal?: AbortSignal): Promise<{ width: number; height: number; close(): void }>;
	/** Set when the lab said this desktop is older than its current image. */
	desktopOutdated?: boolean;
	/** Move the desktop to the lab's current image, keeping its files; absent where a lab can't. */
	desktopUpdate?(signal?: AbortSignal): Promise<void>;
	/** Copy a file from the workspace sandbox onto the desktop; absent where a lab can't. */
	desktopCopy?(from: string, signal?: AbortSignal): Promise<{ path: string; bytes: number }>;
}

const TYPE_MAX = 4_000;
/** Input actions a lab answers without a picture: the client takes one just after, so the agent sees the result. */
const SHOW_AFTER = new Set<DesktopActionName>(["launch", "focus_window", "mouse_move", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "type", "key", "scroll", "wait"]);
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
		const most = info.max_type_chars ?? TYPE_MAX;
		if (typeof raw.text !== "string" || !raw.text) throw new ToolError(`${action} needs text.`);
		if (raw.text.length > most) throw new ToolError(`Type at most ${most} characters at a time.`);
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
	if (action === "wait") out.duration = Math.max(0, Math.min(info.max_wait_seconds ?? 30, Number(raw.duration ?? 1) || 1));
	if (action === "focus_window") {
		if (typeof raw.window !== "string" || !/^0x[0-9a-f]+$/i.test(raw.window)) throw new ToolError("focus_window needs window: an id from state, such as 0x1a00003.");
		out.window = raw.window;
	}
	if (action === "launch") {
		const ids = (info.apps ?? []).map((a) => a.id);
		if (typeof raw.app !== "string" || !raw.app) throw new ToolError(`launch needs app${ids.length ? `: one of ${ids.join(", ")}` : ""}.`);
		if (ids.length && !ids.includes(raw.app)) throw new ToolError(`This desktop has no app ${raw.app}. It has: ${ids.join(", ")}.`);
		out.app = raw.app;
	}
	return out;
}

type Bounds = { x: number; y: number; w: number; h: number };

/** A lab's bounds as x, y, width, height, whichever form it sends ([x, y, w, h] or an object). */
function boundsOf(raw: unknown): Bounds | undefined {
	if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === "number")) return { x: raw[0], y: raw[1], w: raw[2], h: raw[3] };
	if (raw && typeof raw === "object") {
		const b = raw as Record<string, unknown>;
		const n = (k: string[]) => k.map((key) => b[key]).find((v): v is number => typeof v === "number");
		const x = n(["x", "left"]), y = n(["y", "top"]), w = n(["width", "w"]), h = n(["height", "h"]);
		if (x !== undefined && y !== undefined && w !== undefined && h !== undefined) return { x, y, w, h };
	}
	return undefined;
}

const center = (b: Bounds) => `(${Math.round(b.x + b.w / 2)}, ${Math.round(b.y + b.h / 2)})`;
const quoted = (v: unknown) => (typeof v === "string" && v.trim() ? ` "${clip(v.replace(/\s+/g, " ").trim(), 80)}"` : "");

/** The most lines of a window's controls the model gets at once. */
const TREE_LINES = 160;

/** A desktop's state in words a model can act on: its windows, and the focused window's controls with their centers. */
export function describeState(answer: unknown): string {
	const root = (answer && typeof answer === "object" ? ((answer as { state?: unknown }).state ?? answer) : {}) as Record<string, unknown>;
	const lines: string[] = [];
	const screen = root.screen as { width?: number; height?: number } | undefined;
	const cursor = Array.isArray(root.cursor) ? (root.cursor as number[]) : undefined;
	lines.push(`Screen ${screen?.width ?? "?"} by ${screen?.height ?? "?"}.${cursor ? ` Pointer at (${cursor.map(Math.round).join(", ")}).` : ""}`);
	const windows = Array.isArray(root.windows) ? (root.windows as Record<string, unknown>[]) : [];
	if (!windows.length) lines.push("No windows are open. Use launch to start an app.");
	else {
		lines.push("Windows:");
		for (const w of windows) {
			const b = boundsOf(w.bounds);
			const flags = [w.focused ? "focused" : "", w.minimized ? "minimized" : ""].filter(Boolean).join(", ");
			lines.push(`- ${String(w.id ?? "?")} ${String(w.app_id ?? w.app ?? "")}${quoted(w.title)}${b ? ` at (${b.x}, ${b.y}), ${b.w} by ${b.h}` : ""}${flags ? `, ${flags}` : ""}`);
		}
	}
	const focused = root.focused as { window?: unknown; tree?: unknown; truncated?: unknown } | undefined;
	if (focused?.tree) {
		const tree: string[] = [];
		const walk = (node: unknown, depth: number) => {
			if (!node || typeof node !== "object" || tree.length >= TREE_LINES) return;
			if (Array.isArray(node)) {
				for (const child of node) walk(child, depth);
				return;
			}
			const n = node as Record<string, unknown>;
			const b = boundsOf(n.bounds);
			const role = String(n.role ?? n.type ?? "item");
			const value = n.value !== undefined && n.value !== n.name ? ` value${quoted(String(n.value))}` : "";
			const states = Array.isArray(n.states) && n.states.length ? ` [${(n.states as unknown[]).map(String).join(", ")}]` : "";
			tree.push(`${"  ".repeat(Math.min(depth, 12))}${role}${quoted(n.name)}${value}${states}${b && b.w > 0 && b.h > 0 ? ` at ${center(b)}` : ""}`);
			walk(n.children, depth + 1);
		};
		walk(focused.tree, 0);
		lines.push(`Controls in the focused window ${String(focused.window ?? "")} (click a control at its center):`);
		lines.push(...tree);
		if (tree.length >= TREE_LINES || focused.truncated) lines.push("(More controls than shown: use zoom or a screenshot for the rest.)");
	}
	return lines.join("\n");
}

/** A window the lab names in its answer to launch or focus_window. */
function windowSaid(answer: unknown): string {
	const w = (answer && typeof answer === "object" ? (answer as { window?: unknown }).window : undefined) as Record<string, unknown> | string | undefined;
	if (!w) return "";
	if (typeof w === "string") return ` Its window is ${w}.`;
	return ` Its window is ${String(w.id ?? "")}${quoted(w.title)}.`;
}

/** The screenshot in a lab's answer, whichever of the usual names it uses. */
export function frameIn(answer: unknown, site: string, by: "agent" | "person", info?: DesktopInfo): DesktopFrame | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const shot = (answer as { screenshot?: Record<string, unknown> }).screenshot;
	const png = typeof shot?.png === "string" && shot.png ? shot.png : undefined;
	if (!shot || !png) return undefined;
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
		case "state":
			return "Read the desktop's windows and controls.";
		case "launch":
			return `Launched ${a.app}.`;
		case "focus_window":
			return `Focused window ${a.window}.`;
		default:
			return `${a.action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}${at}.`;
	}
}

/** The agent's desktop tools for one lab. They act only inside the lab's desktop sandbox. */
export function desktopTools(site: string, title: string, api: DesktopApi): Tool[] {
	const info = api.desktop();
	if (!info) return [];
	const size = info.screen ? `${info.screen.width} by ${info.screen.height} pixels` : "the size its screenshot shows";
	const actions = info.actions.length ? DESKTOP_ACTIONS.filter((a) => info.actions.includes(a)) : DESKTOP_ACTIONS.filter((a) => a !== "state" && a !== "launch" && a !== "focus_window");
	const reads = actions.includes("state");
	const apps = info.apps ?? [];
	const desktop: Tool = {
		name: `${site}_desktop`,
		kind: "sandbox",
		description: `Use the Linux desktop in your ${title} sandbox, ${size}: for programs that only have a window (a PDF form, a viewer, a web page on the lab's network). ${reads ? "Start with state: it lists the windows and the focused window's controls with the point to click for each, which is more exact than reading a screenshot. " : "Start with a screenshot; coordinates are pixels on that screenshot. "}${actions.includes("launch") && apps.length ? `launch starts an app (${apps.map((a) => `${a.id}${a.title ? ` for ${a.title}` : ""}`).join(", ")}); focus_window brings one forward by its id. ` : ""}Input actions answer with a screenshot taken just after them. Typing takes at most ${info.max_type_chars ?? TYPE_MAX} characters; key takes names like Return, Tab, ctrl+s. The person can watch and use the same desktop. It has no shell: use ${site}_sandbox_run in your other sandbox for commands.`,
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
				...(actions.includes("focus_window") ? { window: { type: "string", description: "focus_window: a window id from state, such as 0x1a00003" } } : {}),
				...(actions.includes("launch") ? { app: apps.length ? { type: "string", enum: apps.map((a) => a.id) } : { type: "string", description: "launch: an app id" } } : {}),
			},
			required: ["action"],
		},
		view: (args) => {
			const a = args as Partial<DesktopAction>;
			const target = a.action === "type" ? `${String(a.text ?? "").length} characters` : a.action === "key" ? String(a.text ?? "") : a.action === "launch" ? String(a.app ?? "") : a.action === "focus_window" ? String(a.window ?? "") : a.coordinate ? `(${a.coordinate.join(", ")})` : "";
			return { verb: `desktop ${String(a.action ?? "").replace(/_/g, " ")}`, target: clip(target, 80) };
		},
		async run(args, ctx) {
			const action = checkAction(args, info);
			const result = await api.desktopAct(action, "agent", ctx.signal);
			if (action.action === "state") {
				const text = describeState(result.answer);
				return { ok: true, content: text, view: { result: `${text.split("\n").length} lines` } };
			}
			const parts = [said(action) + (action.action === "launch" || action.action === "focus_window" ? windowSaid(result.answer) : "")];
			if (result.cursor) parts.push(`The pointer is at (${result.cursor.join(", ")}).`);
			// The lab answers input with no picture; one taken a moment later shows what the action did.
			let frame = result.frame;
			if (!frame && SHOW_AFTER.has(action.action)) {
				await sleep(SETTLE_MS, ctx.signal);
				frame = (await api.desktopAct({ action: "screenshot" }, "agent", ctx.signal)).frame;
			}
			if (frame && !ctx.vision) parts.push("This model can't see images, so the screenshot shows only in the person's desktop pane.");
			return { ok: true, content: parts.join(" "), images: frame && ctx.vision ? [{ type: "image", mime: "image/png", data: frame.png }] : undefined, view: { result: said(action) } };
		},
	};
	if (!info.open) return [desktop];
	const open: Tool = {
		name: `${site}_desktop_open`,
		kind: "sandbox",
		description: `Open an https address or a file under /sandbox on the ${title} desktop, in the program that opens it${info.open_with?.length ? ` (or the app named in with: ${info.open_with.join(", ")})` : ""}. The desktop has its own files, apart from your workspace sandbox${api.desktopCopy ? `: copy one over with ${site}_desktop_copy first` : ""}.`,
		parameters: {
			type: "object",
			properties: {
				target: { type: "string", description: "an https address, or a /sandbox/... file" },
				...(info.open_with?.length ? { with: { type: "string", enum: info.open_with, description: "the app to open it in; the browser when not given" } } : {}),
			},
			required: ["target"],
		},
		view: (args) => ({ verb: "desktop open", target: clip(String(args.target ?? ""), 120) }),
		async run(args, ctx) {
			const target = String(args.target ?? "").trim();
			if (!/^https:\/\//.test(target) && !target.startsWith("/sandbox/")) throw new ToolError("target is an https address or a /sandbox/... file.");
			const app = typeof args.with === "string" && info.open_with?.includes(args.with) ? args.with : undefined;
			try {
				await api.desktopOpen(target, "agent", ctx.signal, app);
			} catch (error) {
				if (!target.startsWith("/sandbox/")) throw error;
				throw new ToolError(`${(error as Error).message} If ${target} is in your workspace sandbox, it isn't on the desktop: the desktop has its own files${api.desktopCopy ? `. Copy it over with ${site}_desktop_copy, then open the path that returns` : ""}.`);
			}
			// A program takes a moment to open its window.
			await sleep(1_500, ctx.signal);
			const frame = (await api.desktopAct({ action: "screenshot" }, "agent", ctx.signal)).frame;
			return { ok: true, content: `Opened ${target}.`, images: frame && ctx.vision ? [{ type: "image", mime: "image/png", data: frame.png }] : undefined };
		},
	};
	if (!api.desktopCopy) return [desktop, open];
	const copy: Tool = {
		name: `${site}_desktop_copy`,
		kind: "sandbox",
		description: `Copy a file from your ${title} workspace sandbox onto its desktop, to open it there with ${site}_desktop_open. The lab scans it on the way. Returns its path on the desktop.`,
		parameters: { type: "object", properties: { path: { type: "string", description: "the file in your workspace sandbox, such as /sandbox/work/form.pdf" } }, required: ["path"] },
		view: (args) => ({ verb: "desktop copy", target: clip(String(args.path ?? ""), 120) }),
		async run(args, ctx) {
			const path = String(args.path ?? "").trim();
			if (!path.startsWith("/sandbox/")) throw new ToolError("path is a file under /sandbox/ in your workspace sandbox.");
			const placed = await api.desktopCopy!(path, ctx.signal);
			return { ok: true, content: `Copied to ${placed.path} on the desktop (${placed.bytes} bytes).`, view: { result: placed.path } };
		},
	};
	return [desktop, open, copy];
}
