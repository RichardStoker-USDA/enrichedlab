// Tabular data for the table and plot panes: CSV, TSV, JSON (an array of records), JSON Lines and Parquet, read into
// typed columns. Columnar storage keeps sorting, filtering and plotting fast on large files.

export type Cell = string | number | boolean | null;

export interface Column {
	name: string;
	type: "number" | "text" | "boolean";
	values: Cell[];
}

export interface Table {
	columns: Column[];
	rows: number;
}

/** RFC 4180 fields: quotes, doubled quotes, separators and newlines inside quotes. */
export function parseDelimited(text: string, separator: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"' && field === "") quoted = true;
		else if (ch === separator) {
			row.push(field);
			field = "";
		} else if (ch === "\n" || ch === "\r") {
			if (ch === "\r" && text[i + 1] === "\n") i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else field += ch;
	}
	if (field !== "" || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const MISSING = new Set(["", "NA", "NaN", "null", "NULL", "None", "nan", "N/A"]);

/** Columns from rows of strings: numbers become numbers when every present value is one. */
function typed(header: string[], body: string[][]): Table {
	const columns: Column[] = header.map((name, c) => {
		const raw = body.map((r) => r[c] ?? "");
		const present = raw.filter((v) => !MISSING.has(v.trim()));
		const numeric = present.length > 0 && present.every((v) => NUMBER.test(v.trim()));
		const bool = !numeric && present.length > 0 && present.every((v) => /^(true|false|TRUE|FALSE)$/.test(v.trim()));
		const values: Cell[] = raw.map((v) => {
			const t = v.trim();
			if (MISSING.has(t)) return null;
			if (numeric) return Number(t);
			if (bool) return /^true$/i.test(t);
			return v;
		});
		return { name: name || `column ${c + 1}`, type: numeric ? "number" : bool ? "boolean" : "text", values };
	});
	return { columns, rows: body.length };
}

function fromRecords(records: Record<string, unknown>[]): Table {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const r of records.slice(0, 1000)) for (const k of Object.keys(r ?? {})) if (!seen.has(k)) seen.add(k), names.push(k);
	const columns: Column[] = names.map((name) => {
		const values = records.map((r) => {
			const v = r?.[name];
			if (v === undefined || v === null) return null;
			if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return v;
			if (typeof v === "bigint") return Number(v);
			if (v instanceof Date) return v.toISOString();
			return JSON.stringify(v);
		});
		const present = values.filter((v) => v !== null);
		const type = present.length && present.every((v) => typeof v === "number") ? "number" : present.length && present.every((v) => typeof v === "boolean") ? "boolean" : "text";
		return { name, type, values } as Column;
	});
	return { columns, rows: records.length };
}

/** Read a file the engine returned for a view. */
export async function readTable(file: { name: string; text?: string; base64?: string }): Promise<Table> {
	const name = file.name.toLowerCase();
	if (name.endsWith(".parquet")) {
		const { parquetReadObjects } = await import("hyparquet");
		const bytes = Uint8Array.from(atob(file.base64 ?? ""), (c) => c.charCodeAt(0));
		const records = (await parquetReadObjects({ file: bytes.buffer })) as Record<string, unknown>[];
		return fromRecords(records);
	}
	const text = file.text ?? "";
	if (name.endsWith(".json")) {
		const parsed = JSON.parse(text) as unknown;
		const records = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { data?: unknown }).data) ? (parsed as { data: unknown[] }).data : [parsed];
		return fromRecords(records as Record<string, unknown>[]);
	}
	if (/\.(jsonl|ndjson)$/.test(name)) {
		return fromRecords(text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>));
	}
	const separator = /\.(tsv|tab)$/.test(name) ? "\t" : text.split("\n", 1)[0]!.includes("\t") && !text.split("\n", 1)[0]!.includes(",") ? "\t" : ",";
	const [header = [], ...body] = parseDelimited(text, separator);
	return typed(header, body);
}

export interface Stats {
	present: number;
	missing: number;
	distinct: number;
	min?: number;
	max?: number;
	mean?: number;
}

export function stats(column: Column): Stats {
	let present = 0;
	let sum = 0;
	let min = Infinity;
	let max = -Infinity;
	const distinct = new Set<Cell>();
	for (const v of column.values) {
		if (v === null) continue;
		present++;
		if (distinct.size < 100_000) distinct.add(v);
		if (typeof v === "number") {
			sum += v;
			if (v < min) min = v;
			if (v > max) max = v;
		}
	}
	const numeric = column.type === "number" && present > 0;
	return { present, missing: column.values.length - present, distinct: distinct.size, ...(numeric ? { min, max, mean: sum / present } : {}) };
}

/** A filter typed in a column's filter box: "> 5", "<= 2.5", "= x", "!= x", or text to search for. */
export function matcher(column: Column, query: string): ((v: Cell) => boolean) | undefined {
	const q = query.trim();
	if (!q) return undefined;
	const op = /^(>=|<=|!=|=|>|<)\s*(.*)$/.exec(q);
	if (op && column.type === "number" && NUMBER.test(op[2]!.trim())) {
		const n = Number(op[2]);
		const test: Record<string, (v: number) => boolean> = { ">": (v) => v > n, "<": (v) => v < n, ">=": (v) => v >= n, "<=": (v) => v <= n, "=": (v) => v === n, "!=": (v) => v !== n };
		return (v) => typeof v === "number" && test[op[1]!]!(v);
	}
	if (op && (op[1] === "=" || op[1] === "!=")) {
		const want = op[2]!.trim().toLowerCase();
		return op[1] === "=" ? (v) => String(v ?? "").toLowerCase() === want : (v) => String(v ?? "").toLowerCase() !== want;
	}
	const needle = q.toLowerCase();
	return (v) => v !== null && String(v).toLowerCase().includes(needle);
}

export function formatCell(v: Cell): string {
	if (v === null) return "";
	if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US", { useGrouping: false }) : Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : String(Number(v.toPrecision(8)));
	return String(v);
}

export function toCsv(table: Table, order: number[]): string {
	const quote = (v: Cell) => {
		const s = v === null ? "" : String(v);
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const lines = [table.columns.map((c) => quote(c.name)).join(",")];
	for (const r of order) lines.push(table.columns.map((c) => quote(c.values[r] ?? null)).join(","));
	return `${lines.join("\n")}\n`;
}
