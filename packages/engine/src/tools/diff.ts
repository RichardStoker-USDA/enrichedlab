// A small line diff for showing edits: unified format with three lines of context. Large inputs fall back to a
// count, since a step line is for reading, not for patching.

const LIMIT = 4_000;

function lcsTable(a: string[], b: string[]): Uint32Array[] {
	const rows: Uint32Array[] = [];
	for (let i = 0; i <= a.length; i++) rows.push(new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
		}
	}
	return rows;
}

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

export function unifiedDiff(before: string, after: string, path: string): { diff: string; added: number; removed: number } {
	// A final newline ends the last line; it isn't an extra empty line.
	const splitLines = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));
	const a = splitLines(before);
	const b = splitLines(after);
	if (a.length > LIMIT || b.length > LIMIT || a.length * b.length > 4_000_000) {
		return { diff: `--- ${path}\n+++ ${path}\n(${a.length} lines before, ${b.length} after; too large to show)`, added: b.length, removed: a.length };
	}
	// Trim the common head and tail so the table stays small.
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const am = a.slice(head, a.length - tail);
	const bm = b.slice(head, b.length - tail);
	const table = lcsTable(am, bm);
	const ops: Op[] = [];
	for (let k = 0; k < head; k++) ops.push({ kind: " ", line: a[k], a: k, b: k });
	let i = 0;
	let j = 0;
	while (i < am.length || j < bm.length) {
		if (i < am.length && j < bm.length && am[i] === bm[j]) {
			ops.push({ kind: " ", line: am[i], a: head + i, b: head + j });
			i++;
			j++;
		} else if (i < am.length && (j >= bm.length || table[i + 1][j] >= table[i][j + 1])) {
			// On a tie, removals come first, the way git shows a changed line.
			ops.push({ kind: "-", line: am[i], a: head + i, b: head + j });
			i++;
		} else {
			ops.push({ kind: "+", line: bm[j], a: head + i, b: head + j });
			j++;
		}
	}
	for (let k = 0; k < tail; k++) ops.push({ kind: " ", line: a[a.length - tail + k], a: a.length - tail + k, b: b.length - tail + k });

	const added = ops.filter((o) => o.kind === "+").length;
	const removed = ops.filter((o) => o.kind === "-").length;
	const lines = [`--- ${path}`, `+++ ${path}`];
	const context = 3;
	let k = 0;
	while (k < ops.length) {
		if (ops[k].kind === " ") {
			k++;
			continue;
		}
		let start = Math.max(0, k - context);
		let end = k;
		while (end < ops.length) {
			if (ops[end].kind !== " ") {
				end++;
				continue;
			}
			let run = 0;
			while (end + run < ops.length && ops[end + run].kind === " ") run++;
			if (end + run >= ops.length || run > context * 2) {
				end = Math.min(ops.length, end + context);
				break;
			}
			end += run;
		}
		const hunk = ops.slice(start, end);
		const aStart = hunk[0].a + 1;
		const bStart = hunk[0].b + 1;
		const aLen = hunk.filter((o) => o.kind !== "+").length;
		const bLen = hunk.filter((o) => o.kind !== "-").length;
		lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
		for (const o of hunk) lines.push(`${o.kind}${o.line}`);
		k = end;
		start = end;
	}
	return { diff: lines.join("\n"), added, removed };
}
