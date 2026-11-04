// PDF forms: list a form's fields with the printed words beside each one, and fill them into a new file. Field names
// inside forms are often codes (f1_01), so the label comes from the page text nearest the field. Uses Mozilla's
// pdf.js, which reads AcroForm and hybrid forms; a pure XFA form is reported as such.

import { basename, dirname, extname, join } from "node:path";
import type { Tool } from "./types.ts";
import { str, ToolError } from "./types.ts";

interface Widget {
	id: string;
	page: number;
	kind: "text" | "checkbox" | "radio" | "choice";
	name: string;
	value: string;
	label: string;
	options?: string[];
	on?: string;
}

type Item = { str: string; transform: number[]; width: number; height: number };

/** pdf.js, loaded the first time a PDF tool runs. Its Node build warns that it can't draw (no canvas package); these
 * tools only read and fill forms, so the warnings are dropped. The worker module is imported here too, which bundles
 * it into the compiled binary and lets pdf.js parse in-process. */
let library: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
function pdfjs() {
	library ??= (async () => {
		const [log, warn] = [console.log, console.warn];
		const quiet = (...args: unknown[]) => (/^Warning: Cannot (load|polyfill)/.test(String(args[0])) ? undefined : log(...args));
		console.log = quiet;
		console.warn = quiet;
		try {
			const [lib, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.mjs")]);
			(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
			return lib;
		} finally {
			[console.log, console.warn] = [log, warn];
		}
	})();
	return library;
}

async function open(data: Buffer) {
	const { getDocument } = await pdfjs();
	return getDocument({ data: new Uint8Array(data), verbosity: 0, disableFontFace: true, useSystemFonts: false }).promise;
}

/** The printed words nearest a field: beside it on its line (to the right first for boxes), or just above it. */
function labelFor(rect: number[], items: Item[], box: boolean): string {
	const [x1, y1, x2, y2] = rect as [number, number, number, number];
	const mid = (y1 + y2) / 2;
	const band = Math.max(6, (y2 - y1) * 0.7);
	let best: { item: Item; score: number } | undefined;
	for (const t of items) {
		// Words only: line numbers, dots and dashes beside a field aren't its label.
		if (!/[A-Za-z]{2}/.test(t.str)) continue;
		const [x, y] = [t.transform[4]!, t.transform[5]!];
		let score = Number.POSITIVE_INFINITY;
		if (Math.abs(y + t.height / 3 - mid) < band) {
			if (x >= x2 - 1) score = (x - x2) * (box ? 0.5 : 1.5);
			else if (x + t.width <= x1 + 1) score = (x1 - (x + t.width)) * (box ? 1.5 : 1);
		} else if (y > y2 - 2 && y - y2 < 24 && x < x1 + 120 && x + t.width > x1 - 10) {
			score = (y - y2) * 2 + Math.abs(x - x1) / 8 + (box ? 20 : 0);
		}
		if (score < 160 && (!best || score < best.score)) best = { item: t, score };
	}
	if (!best) return "";
	// The rest of that line's phrase: neighbours on the same baseline with no wide gap.
	const line = items.filter((t) => Math.abs(t.transform[5]! - best!.item.transform[5]!) < 1.5 && t.str.trim()).sort((a, b) => a.transform[4]! - b.transform[4]!);
	const at = line.indexOf(best.item);
	let [from, to] = [at, at];
	while (from > 0 && line[from]!.transform[4]! - (line[from - 1]!.transform[4]! + line[from - 1]!.width) < 6) from--;
	while (to < line.length - 1 && line[to + 1]!.transform[4]! - (line[to]!.transform[4]! + line[to]!.width) < 6) to++;
	return line
		.slice(from, to + 1)
		.map((t) => t.str.trim())
		.join(" ")
		.replace(/\s+/g, " ")
		.slice(0, 120);
}

async function widgets(data: Buffer): Promise<{ doc: Awaited<ReturnType<typeof open>>; list: Widget[] }> {
	const doc = await open(data);
	if (doc.isPureXfa) throw new ToolError("This is an XFA form (made in Adobe LiveCycle); pdf.js can't fill it. Open it in the browser pane or Adobe Reader.");
	const list: Widget[] = [];
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n);
		const [annotations, text] = await Promise.all([page.getAnnotations(), page.getTextContent()]);
		const items = text.items.filter((i) => "str" in i) as unknown as Item[];
		for (const a of annotations as Record<string, unknown>[]) {
			if (a.subtype !== "Widget" || a.pushButton || a.hidden) continue;
			const type = a.fieldType === "Tx" ? "text" : a.fieldType === "Ch" ? "choice" : a.radioButton ? "radio" : a.checkBox ? "checkbox" : undefined;
			if (!type) continue;
			const tooltip = String(a.alternativeText ?? "").trim();
			list.push({
				id: String(a.id),
				page: n,
				kind: type,
				name: String(a.fieldName ?? ""),
				value: Array.isArray(a.fieldValue) ? a.fieldValue.join(", ") : String(a.fieldValue ?? ""),
				label: tooltip || labelFor(a.rect as number[], items, type === "checkbox" || type === "radio"),
				options: Array.isArray(a.options) ? (a.options as { displayValue: string }[]).map((o) => o.displayValue) : undefined,
				on: type === "radio" ? String(a.buttonValue ?? "") : type === "checkbox" ? String(a.exportValue ?? "Yes") : undefined,
			});
		}
	}
	return { doc, list };
}

export const pdfFieldsTool: Tool<{ path: string }> = {
	name: "pdf_fields",
	description:
		"List a PDF form's fillable fields: id, page, kind, the printed label beside it, and its value. Use the ids with pdf_fill. Read the form's text (read tool) too when labels are unclear.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	kind: "read",
	view: (args) => ({ verb: "Form fields", target: args.path }),
	async run(args, ctx) {
		const { list } = await widgets(await ctx.workspace.read(str(args, "path")));
		if (!list.length) return { ok: true, content: "This PDF has no fillable fields. To complete it, write the answers into a new document or annotate a copy.", view: { result: "no fields" } };
		const lines = list.map(
			(w) =>
				`${w.id}  p${w.page}  ${w.kind}${w.on ? ` (on=${w.on})` : ""}  "${w.label}"  = ${JSON.stringify(w.value)}${w.options ? `  options: ${w.options.join(" | ")}` : ""}`,
		);
		return { ok: true, content: `${list.length} fields (id, page, kind, label, value):\n${lines.join("\n")}`, view: { result: `${list.length} fields` } };
	},
};

export const pdfFillTool: Tool<{ path: string; values: Record<string, string | boolean>; out?: string }> = {
	name: "pdf_fill",
	description:
		"Fill a PDF form's fields by id (from pdf_fields) into a new file. Text and choices take strings; checkboxes take true or false; for radio buttons set the chosen button's id to true. The original stays as it was.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			values: { type: "object", additionalProperties: { type: ["string", "boolean"] } },
			out: { type: "string", description: "Where to write the filled copy; defaults to <name>_filled.pdf beside it" },
		},
		required: ["path", "values"],
	},
	kind: "write",
	touches: (args) => [args.out ?? join(dirname(args.path), `${basename(args.path, extname(args.path))}_filled.pdf`)],
	view: (args) => ({ verb: "Fill form", target: args.out ?? args.path, detail: Object.entries(args.values ?? {}).map(([k, v]) => `${k} = ${v}`).join("\n") }),
	async run(args, ctx) {
		const path = str(args, "path");
		const out = args.out ?? join(dirname(path), `${basename(path, extname(path))}_filled.pdf`);
		const { doc, list } = await widgets(await ctx.workspace.read(path));
		const byId = new Map(list.map((w) => [w.id, w]));
		const unknown = Object.keys(args.values ?? {}).filter((id) => !byId.has(id));
		if (unknown.length) throw new ToolError(`No fields with ids ${unknown.join(", ")}; pdf_fields lists them.`);
		for (const [id, value] of Object.entries(args.values)) {
			const field = byId.get(id)!;
			const v = field.kind === "checkbox" || field.kind === "radio" ? value === true || value === "true" || value === field.on : String(value);
			doc.annotationStorage.setValue(id, { value: v });
		}
		const bytes = Buffer.from(await doc.saveDocument());
		await ctx.workspace.write(out, bytes);
		return { ok: true, content: `Filled ${Object.keys(args.values).length} fields into ${ctx.workspace.display(out)}. Check it with pdf_fields, or show it to the person in the browser pane.`, view: { result: `${Object.keys(args.values).length} fields` } };
	},
};
