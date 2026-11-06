// The run sheet's shape: the session's events as blocks a person reads top to bottom. A prompt; the agent's thinking;
// its steps grouped into one activity per stretch between answers; its answer; and the rare notices. Pure, so the
// grouping and the activity summaries are tested without a browser.

import type { PermissionRequest, SessionEvent } from "@enrichedlab/protocol";

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;

export type StepItem = { kind: "done"; id: string; event: Ev<"tool"> } | { kind: "running"; id: string; name: string; target: string; waiting?: PermissionRequest };

export type Block =
	| { kind: "prompt"; id: string; text: string; images: number }
	| { kind: "thinking"; id: string; text: string }
	| { kind: "activity"; id: string; steps: StepItem[] }
	| { kind: "answer"; id: string; text: string; error?: string; stop: string }
	| { kind: "notice"; id: string; level: string; text: string }
	| { kind: "rule"; id: string; text: string };

export function blocks(events: SessionEvent[], running: { calls: { id: string; name: string; target: string }[]; pending: PermissionRequest[] } | undefined): Block[] {
	const out: Block[] = [];
	const activity = (): Extract<Block, { kind: "activity" }> => {
		const last = out.at(-1);
		if (last?.kind === "activity") return last;
		const made = { kind: "activity" as const, id: `a-${out.length}`, steps: [] as StepItem[] };
		out.push(made);
		return made;
	};
	for (const e of events) {
		if (e.t === "user") out.push({ kind: "prompt", id: e.id, text: e.text, images: e.images?.length ?? 0 });
		else if (e.t === "assistant") {
			if (e.reasoning?.trim()) out.push({ kind: "thinking", id: `${e.id}-r`, text: e.reasoning });
			if (e.text || e.stop === "error" || e.stop === "cancelled") out.push({ kind: "answer", id: e.id, text: e.text, error: e.error, stop: e.stop });
		} else if (e.t === "tool") {
			activity().steps.push({ kind: "done", id: e.id, event: e });
		} else if (e.t === "notice") out.push({ kind: "notice", id: e.id, level: e.level, text: e.text });
		else if (e.t === "compaction") out.push({ kind: "rule", id: e.id, text: `Earlier turns summarized to save room · ${Math.round(e.tokensBefore / 1000)}k tokens` });
		else if (e.t === "undo") out.push({ kind: "rule", id: e.id, text: `Undone · ${e.files.join(", ")}` });
		else if (e.t === "discovery") out.push({ kind: "rule", id: e.id, text: e.on ? "Discovery mode on · the agent works without asking at the lab" : "Discovery mode off" });
		else if (e.t === "place" && !e.initial) out.push({ kind: "rule", id: e.id, text: e.place === "local" ? "Moved back to this computer" : `Moved to ${e.label.replace(/^the /, "").replace(/ \(.*$/, "")}` });
	}
	if (running) {
		const done = new Set(events.filter((e) => e.t === "tool").map((e) => (e as Ev<"tool">).callId));
		for (const call of running.calls) {
			if (done.has(call.id)) continue;
			const waiting = running.pending.find((p) => p.callId === call.id);
			activity().steps.push({ kind: "running", id: call.id, name: waiting?.view.verb ?? call.name, target: waiting?.view.target ?? call.target, waiting });
		}
	}
	return out;
}

const READS = new Set(["read", "ls", "glob", "grep", "recall"]);
const EDITS = new Set(["edit", "write"]);

/** One line for a finished activity: "Read 4 files, ran 2 commands, edited geom.py". */
export function summarize(steps: StepItem[]): string {
	let reads = 0;
	let searches = 0;
	let commands = 0;
	let failed = 0;
	const edited: string[] = [];
	const other: string[] = [];
	for (const s of steps) {
		if (s.kind !== "done") continue;
		const name = s.event.name;
		const verb = s.event.view?.verb ?? name;
		if (!s.event.ok) failed++;
		if (name === "grep" || name === "glob") searches++;
		else if (READS.has(name)) reads++;
		else if (name === "shell" || /_sandbox_run$|_sandbox_job_start$/.test(name)) commands++;
		else if (EDITS.has(name)) {
			const file = (s.event.view?.target ?? "").split("/").pop() ?? "";
			if (file && !edited.includes(file)) edited.push(file);
		} else if (!other.includes(verb)) other.push(verb);
	}
	const parts: string[] = [];
	if (reads) parts.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
	if (searches) parts.push(`searched ${searches} time${searches === 1 ? "" : "s"}`);
	if (commands) parts.push(`ran ${commands} command${commands === 1 ? "" : "s"}`);
	if (edited.length) parts.push(`edited ${edited.length > 3 ? `${edited.length} files` : edited.join(", ")}`);
	for (const verb of other.slice(0, 3)) parts.push(verb);
	if (failed) parts.push(`${failed} failed`);
	const text = parts.join(", ");
	return text ? text[0]!.toUpperCase() + text.slice(1) : `${steps.length} step${steps.length === 1 ? "" : "s"}`;
}
