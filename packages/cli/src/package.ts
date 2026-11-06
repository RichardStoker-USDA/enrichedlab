// A session as a run package (docs/research.md): one RO-Crate 1.3 folder, Process Run Crate profile, holding the shared
// session log, its images, the files the session changed (on this computer) with their checksums, and every model step
// and tool call as an action with its times, outcome and reading summary. WHNRC's evidence exports pin the same
// versions, so a scientist reads both the same way.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { SessionEvent, SessionSummary } from "@enrichedlab/protocol";

const CRATE = "https://w3id.org/ro/crate/1.3";
const PROFILE = "https://w3id.org/ro/wfrun/process/0.6";

type Ev<T extends SessionEvent["t"]> = Extract<SessionEvent, { t: T }>;
type Entity = Record<string, unknown> & { "@id": string; "@type": string | string[] };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface PackageInput {
	summary: SessionSummary;
	/** The engine's own events, for times, models and summaries. */
	events: SessionEvent[];
	/** The shared log (el session export) and the images it refers to. */
	log: unknown[];
	attachments: Record<string, { mime: string; data: string }>;
}

/** Write the package into `folder`; answers how many files and actions it describes. */
export function writePackage(folder: string, input: PackageInput): { files: number; actions: number } {
	mkdirSync(join(folder, "images"), { recursive: true });
	const graph: Entity[] = [];
	const parts: { "@id": string }[] = [];
	const file = (path: string, bytes: Buffer, extra: Record<string, unknown>) => {
		writeFileSync(join(folder, path), bytes);
		graph.push({ "@id": path, "@type": "File", contentSize: String(bytes.length), sha256: sha256(bytes), ...extra });
		parts.push({ "@id": path });
	};

	file("session.jsonl", Buffer.from(input.log.map((e) => JSON.stringify(e)).join("\n") + "\n"), { name: "Session log", description: "Every message, model step with its full reasoning, tool call and output, in the shared log format v1.", encodingFormat: "application/jsonl" });
	for (const [hash, image] of Object.entries(input.attachments)) {
		file(`images/${hash}.${image.mime.split("/")[1] ?? "bin"}`, Buffer.from(image.data, "base64"), { encodingFormat: image.mime });
	}

	// Files the session changed, as they are now, when they are on this computer. A lab session's files stay in the
	// lab's sandbox; the log names them.
	const local = !input.summary.place || input.summary.place === "local";
	const changed = new Set<string>();
	for (const e of input.events) if (e.t === "checkpoint") for (const f of e.files) changed.add(f.path);
	let copied = 0;
	if (local) {
		for (const path of [...changed].sort()) {
			const full = isAbsolute(path) ? path : resolve(input.summary.cwd, path);
			const inside = relative(input.summary.cwd, full);
			if (inside.startsWith("..") || isAbsolute(inside) || !existsSync(full) || !statSync(full).isFile()) continue;
			const target = join("files", inside);
			mkdirSync(join(folder, target, ".."), { recursive: true });
			copyFileSync(full, join(folder, target));
			const bytes = readFileSync(full);
			graph.push({ "@id": target.split("\\").join("/"), "@type": "File", name: inside, contentSize: String(bytes.length), sha256: sha256(bytes), description: "A file the session changed, as it is now." });
			parts.push({ "@id": target.split("\\").join("/") });
			copied++;
		}
	}

	// Every model step and tool call as an action: what ran, when, with what, and how it ended.
	const summaries = new Map<string, string>();
	for (const e of input.events) if (e.t === "reasoning_summary") summaries.set(e.of, e.text);
	const tools = new Map<string, Ev<"tool">>();
	for (const e of input.events) if (e.t === "tool") tools.set(e.callId, e);
	const instruments = new Map<string, Entity>();
	const instrument = (id: string, name: string, description: string) => {
		if (!instruments.has(id)) instruments.set(id, { "@id": id, "@type": "SoftwareApplication", name, description });
		return { "@id": id };
	};
	const actions: Entity[] = [];
	let previous = input.events[0]?.at;
	for (const e of input.events) {
		if (e.t === "user") previous = e.at;
		if (e.t !== "assistant") continue;
		const model = instrument(`#model-${e.model}`, e.model, "The model that wrote this step.");
		actions.push({
			"@id": `#step-${e.id}`,
			"@type": "CreateAction",
			name: e.toolCalls?.length ? `Model step: ${e.toolCalls.length} tool call${e.toolCalls.length === 1 ? "" : "s"}` : "Model step: answer",
			instrument: model,
			startTime: previous,
			endTime: e.at,
			actionStatus: e.stop === "error" ? "FailedActionStatus" : "CompletedActionStatus",
			...(summaries.has(e.id) ? { description: summaries.get(e.id) } : {}),
		});
		for (const call of e.toolCalls ?? []) {
			const result = tools.get(call.id);
			actions.push({
				"@id": `#call-${call.id}`,
				"@type": "CreateAction",
				name: result?.view ? `${result.view.verb} ${result.view.target ?? ""}`.trim() : call.name,
				instrument: instrument(`#tool-${call.name}`, call.name, "A tool the agent called."),
				startTime: e.at,
				...(result ? { endTime: result.at } : {}),
				actionStatus: !result ? "PotentialActionStatus" : result.ok ? "CompletedActionStatus" : "FailedActionStatus",
				...(result?.decision ? { description: `Permission: ${result.decision}.` } : {}),
			});
		}
		previous = e.at;
	}

	const metadata = {
		"@context": `${CRATE}/context`,
		"@graph": [
			{ "@id": "ro-crate-metadata.json", "@type": "CreativeWork", conformsTo: { "@id": CRATE }, about: { "@id": "./" } },
			{
				"@id": "./",
				"@type": "Dataset",
				name: input.summary.title,
				description: `An EnrichedLab session${local ? "" : ` that worked in the ${input.summary.place} sandbox`}: its log, ${copied ? "the files it changed, " : ""}and every model step and tool call.`,
				datePublished: new Date().toISOString(),
				conformsTo: [{ "@id": PROFILE }],
				hasPart: parts,
				mentions: actions.map((a) => ({ "@id": a["@id"] })),
			},
			{ "@id": PROFILE, "@type": "CreativeWork", name: "Process Run Crate", version: "0.6" },
			...graph,
			...instruments.values(),
			...actions,
		],
	};
	writeFileSync(join(folder, "ro-crate-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
	return { files: copied, actions: actions.length };
}
