// The shared session log, v1 (docs/session-log.md): the format the engine and Gate's Rein both read, so a session can
// move between the desktop, the browser and a role agent and rebuild the same context. The engine keeps its own log
// on disk and maps to v1 on export and from v1 on import.

import { createHash } from "node:crypto";
import type { LogV1Event, Part, SessionEvent, StopReason } from "@enrichedlab/protocol";
import { newId } from "../util.ts";

/** An image kept by reference: the bytes live beside the log (export) or in the person's Gate files (Rein). */
export interface ImageRef {
	uri: string;
	sha256: string;
	mime: string;
	bytes: number;
}

export type V1Kind = "user" | "assistant" | "decision" | "tool_result" | "notice" | "error" | "compaction" | `x-${string}`;

export type V1Event = LogV1Event & { kind: V1Kind };

/** Image bytes by sha256, for the refs in an export. */
export type Attachments = Record<string, { mime: string; data: string }>;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function refs(parts: Part[] | undefined, attachments: Attachments): ImageRef[] | undefined {
	const images = (parts ?? []).filter((p): p is Extract<Part, { type: "image" }> => p.type === "image");
	if (!images.length) return undefined;
	return images.map((image) => {
		const bytes = Buffer.from(image.data, "base64");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		attachments[sha256] = { mime: image.mime, data: image.data };
		return { uri: `images/${sha256}.${EXT[image.mime] ?? "bin"}`, sha256, mime: image.mime, bytes: bytes.length };
	});
}

function parts(list: unknown, attachments: Attachments): Part[] | undefined {
	if (!Array.isArray(list) || !list.length) return undefined;
	const out: Part[] = [];
	for (const ref of list as ImageRef[]) {
		const found = attachments[ref?.sha256];
		if (!found) continue;
		// The bytes must match the reference they came with.
		const sha = createHash("sha256").update(Buffer.from(found.data, "base64")).digest("hex");
		if (sha === ref.sha256) out.push({ type: "image", mime: found.mime, data: found.data });
	}
	return out.length ? out : undefined;
}

/** The shared log's limits (docs/session-log.md): calls per assistant event, and records per log. */
export const MAX_CALLS = 64;
export const MAX_RECORDS = 20_000;

const DECISION: Record<string, { verdict: string; by: string }> = {
	auto: { verdict: "allow", by: "rule" },
	allowed: { verdict: "allow", by: "person" },
	allowed_session: { verdict: "allow", by: "person" },
	denied: { verdict: "deny", by: "person" },
	refused: { verdict: "deny", by: "rule" },
};

/** The engine's log as v1 events, with the image bytes its refs point at. */
export function toV1(events: SessionEvent[]): { events: V1Event[]; attachments: Attachments } {
	const out: V1Event[] = [];
	const attachments: Attachments = {};
	const seqOf = new Map<string, number>();
	const push = (time: string, kind: V1Kind, data: Record<string, unknown>, id?: string) => {
		const seq = out.length + 1;
		out.push({ v: 1, seq, time, kind, data });
		if (id) seqOf.set(id, seq);
	};
	// Each call's v1 id, in the order its results come: ids are made unique within a turn, and a turn's calls past
	// the format's 64 have no id here, so their results are left out with the calls.
	const callIds = new Map<string, string[]>();
	let lastThrough = 0;
	for (const e of events) {
		if (e.t === "user") push(e.at, "user", { text: e.text, ...(refs(e.images, attachments) ? { images: refs(e.images, attachments) } : {}) }, e.id);
		else if (e.t === "assistant") {
			const all = e.toolCalls ?? [];
			const seen = new Set<string>();
			const calls = all.slice(0, MAX_CALLS).map((c) => {
				let id = c.id;
				for (let n = 2; seen.has(id); n++) id = `${c.id}~${n}`;
				seen.add(id);
				callIds.set(c.id, [...(callIds.get(c.id) ?? []), id]);
				return { id, name: c.name, arguments: c.args };
			});
			push(e.at, "assistant", { text: e.text, ...(e.reasoning ? { reasoning: e.reasoning } : {}), calls, stop: e.stop, model: e.model }, e.id);
			if (all.length > calls.length) push(e.at, "notice", { level: "warn", text: `${all.length - calls.length} more tool calls in this turn were left out: the shared log takes ${MAX_CALLS} per turn.` });
			if (e.stop === "error" && e.error) push(e.at, "error", { text: e.error });
		} else if (e.t === "tool") {
			const callId = callIds.get(e.callId)?.shift();
			if (!callId) continue;
			const decided = DECISION[e.decision ?? "auto"] ?? DECISION.auto!;
			push(e.at, "decision", { callId, tool: e.name, ...decided });
			const images = refs(e.images, attachments);
			push(e.at, "tool_result", { callId, tool: e.name, output: e.content, ...(e.decision === "denied" || e.decision === "refused" ? { refused: true } : {}), ...(!e.ok ? { error: true } : {}), ...(images ? { images } : {}) }, e.id);
		} else if (e.t === "notice") push(e.at, "notice", { level: e.level === "info" ? "info" : "warn", text: e.text }, e.id);
		else if (e.t === "compaction") {
			// v1 names the last event the summary covers; the engine names the first one it keeps. `through` always
			// names an earlier event and never goes back.
			const kept = events.findIndex((x) => x.id === e.firstKeptId);
			const before = kept > 0 ? events.slice(0, kept).reverse().find((x) => seqOf.has(x.id)) : undefined;
			const through = Math.min(Math.max(before ? seqOf.get(before.id)! : 0, lastThrough), out.length);
			lastThrough = through;
			push(e.at, "compaction", { summary: e.summary, through, model: e.model }, e.id);
		} else {
			// Everything else is the engine's own: kept for a faithful re-import, skipped by other readers.
			const { t, id: _id, at, ...rest } = e as SessionEvent & Record<string, unknown>;
			push(at, `x-${t.replace(/_/g, "-")}`, rest, e.id);
		}
	}
	return { events: fit(out), attachments };
}

/**
 * A log over the shared format's record limit keeps its newest part, from a turn's start, behind one compaction that
 * says what was left out (the latest summary when there is one), so every export imports.
 */
function fit(out: V1Event[]): V1Event[] {
	if (out.length <= MAX_RECORDS) return out;
	let start = out.length - (MAX_RECORDS - 1);
	while (start < out.length && out[start]!.kind !== "user") start++;
	const kept = out.slice(start);
	const latest = out.slice(0, start).reverse().find((e) => e.kind === "compaction");
	const left = `The first ${start.toLocaleString("en-US")} records of this session were left out of the export to fit the shared log's ${MAX_RECORDS.toLocaleString("en-US")} records.`;
	const head: V1Event = { v: 1, seq: 1, time: kept[0]?.time ?? out[start - 1]!.time, kind: "compaction", data: { summary: latest ? `${latest.data.summary}\n\n${left}` : left, through: 0, model: latest?.data.model ?? "" } };
	// New numbers from 2; a later compaction's `through` moves with them and never goes back.
	let floor = 0;
	return [
		head,
		...kept.map((e, i) => {
			const seq = i + 2;
			if (e.kind !== "compaction") return { ...e, seq };
			const old = Number(e.data.through ?? 0);
			const through = Math.min(seq - 1, Math.max(floor, old > start ? old - start + 1 : 0));
			floor = through;
			return { ...e, seq, data: { ...e.data, through } };
		}),
	];
}

const STOPS = new Set<StopReason>(["end", "tool_use", "length", "error", "cancelled"]);

/**
 * v1 events as engine events to append after a new session's header. Unknown kinds are skipped; the engine's own
 * x- kinds come back as they were. A call left without a result gets the stand-in the format names.
 */
export function fromV1(input: LogV1Event[], attachments: Attachments = {}): { events: SessionEvent[]; cwd?: string } {
	const events: SessionEvent[] = [];
	const idOfSeq = new Map<number, string>();
	const decisions = new Map<string, { verdict?: string; by?: string }>();
	const open = new Map<string, string>();
	let cwd: string | undefined;
	const sorted = [...input].filter((e) => e && e.v === 1 && typeof e.seq === "number").sort((a, b) => a.seq - b.seq);
	const closeOpen = (at: string) => {
		for (const [callId, name] of open) events.push({ t: "tool", id: newId("e"), at, callId, name, ok: false, content: `The ${name} call never finished (the run was stopped).`, decision: "auto" });
		open.clear();
	};
	const pendingCompactions: { at: string; summary: string; through: number; model: string }[] = [];
	for (const e of sorted) {
		const d = e.data ?? {};
		const at = typeof e.time === "string" ? e.time : new Date().toISOString();
		const id = newId("e");
		if (e.kind === "user") {
			closeOpen(at);
			events.push({ t: "user", id, at, text: String(d.text ?? ""), ...(parts(d.images, attachments) ? { images: parts(d.images, attachments) } : {}) });
		} else if (e.kind === "assistant") {
			closeOpen(at);
			const calls = Array.isArray(d.calls) ? (d.calls as { id: string; name: string; arguments: unknown }[]) : [];
			for (const c of calls) open.set(String(c.id), String(c.name));
			const stop = STOPS.has(d.stop as StopReason) ? (d.stop as StopReason) : calls.length ? "tool_use" : "end";
			events.push({ t: "assistant", id, at, model: String(d.model ?? ""), text: String(d.text ?? ""), ...(typeof d.reasoning === "string" ? { reasoning: d.reasoning } : {}), ...(calls.length ? { toolCalls: calls.map((c) => ({ id: String(c.id), name: String(c.name), args: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) })) } : {}), stop });
		} else if (e.kind === "decision") {
			decisions.set(String(d.callId), { verdict: d.verdict as string, by: d.by as string });
			continue;
		} else if (e.kind === "tool_result") {
			const callId = String(d.callId);
			// A result for no open call is dropped, so the history stays valid.
			if (!open.has(callId)) continue;
			open.delete(callId);
			const decided = decisions.get(callId);
			const decision = d.refused ? (decided?.by === "person" ? "denied" : "refused") : decided?.by === "person" ? "allowed" : "auto";
			events.push({ t: "tool", id, at, callId, name: String(d.tool ?? ""), ok: !d.error && !d.refused, content: String(d.output ?? ""), decision, ...(parts(d.images, attachments) ? { images: parts(d.images, attachments) } : {}) });
		} else if (e.kind === "notice") events.push({ t: "notice", id, at, level: d.level === "info" ? "info" : "warn", text: String(d.text ?? "") });
		else if (e.kind === "error") events.push({ t: "notice", id, at, level: "error", text: String(d.text ?? "") });
		else if (e.kind === "compaction") {
			pendingCompactions.push({ at, summary: String(d.summary ?? ""), through: Number(d.through ?? 0), model: String(d.model ?? "") });
			continue;
		} else if (e.kind === "x-header") {
			if (typeof d.cwd === "string") cwd = d.cwd;
			continue;
		} else if (typeof e.kind === "string" && e.kind.startsWith("x-")) {
			const t = e.kind.slice(2).replace(/-/g, "_");
			// The engine's own kinds, as they were; a reader that doesn't know one skips it.
			if (!["elide", "model", "title", "checkpoint", "undo", "place", "app_context", "local"].includes(t)) continue;
			events.push({ ...(d as object), t, id, at } as SessionEvent);
		} else continue;
		idOfSeq.set(e.seq, id);
	}
	closeOpen(sorted.at(-1)?.time ?? new Date().toISOString());
	// A compaction keeps everything after `through`: the engine names the first event it keeps.
	for (const c of pendingCompactions) {
		const firstKept = sorted.find((e) => e.seq > c.through && idOfSeq.has(e.seq));
		if (firstKept) events.push({ t: "compaction", id: newId("e"), at: c.at, summary: c.summary, firstKeptId: idOfSeq.get(firstKept.seq)!, tokensBefore: 0, model: c.model });
	}
	return { events, cwd };
}
