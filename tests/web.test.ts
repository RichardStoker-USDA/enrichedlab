// The web surface's pure logic: the workbench layout tree, the run sheet's grouping, and data parsing.

import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../packages/protocol/src/index.ts";
import { parseDelimited, readTable, matcher, stats } from "../packages/web/src/lib/data.ts";
import { allTabs, close, emptyLayout, groups, move, open, place, revive } from "../packages/web/src/lib/layout.ts";
import { blocks, summarize } from "../packages/web/src/lib/turns.ts";

describe("workbench layout", () => {
	test("a tab moves to a position in its own strip and into another group's", () => {
		const tab = (id: string) => ({ id, kind: "files" as const, title: id });
		let root = open(open(open(emptyLayout(), tab("a")), tab("b")), tab("c"));
		const first = groups(root)[0]!.id;
		root = place(root, "a", first, 3);
		expect(groups(root)[0]!.tabs.map((t) => t.id)).toEqual(["b", "c", "a"]);
		root = place(root, "a", first, 0);
		expect(groups(root)[0]!.tabs.map((t) => t.id)).toEqual(["a", "b", "c"]);
		root = move(root, "c", first, "right");
		const second = groups(root)[1]!.id;
		root = place(root, "a", second, 0);
		expect(groups(root).map((g) => g.tabs.map((t) => t.id))).toEqual([["b"], ["a", "c"]]);
		expect(groups(root)[1]!.active).toBe("a");
		expect(groups(root)[0]!.active).toBe("b");
	});

	test("tabs open once, split to an edge, and empty groups fold away when closed", () => {
		let root = open(emptyLayout(), { id: "t1", kind: "table", title: "a.csv", ref: "c1" });
		root = open(root, { id: "t2", kind: "table", title: "a.csv", ref: "c1" });
		expect(allTabs(root)).toHaveLength(1);
		root = open(root, { id: "t3", kind: "terminal", title: "Terminal", ref: "t3" });
		root = move(root, "t3", groups(root)[0]!.id, "bottom");
		expect(root.type).toBe("split");
		expect(root.type === "split" && root.dir).toBe("column");
		root = close(root, "t3");
		expect(root.type).toBe("group");
		expect(allTabs(root).map((t) => t.id)).toEqual(["t1"]);
		expect(revive({ type: "nonsense" }).type).toBe("group");
	});
});

describe("run sheet", () => {
	const at = "2026-11-04T00:00:00Z";
	const tool = (id: string, name: string, target: string, ok = true) => ({ t: "tool", id, at, callId: id, name, ok, content: "", view: { verb: name, target } }) as unknown as SessionEvent;
	test("steps between answers group into one activity with a plain summary", () => {
		const events = [
			{ t: "user", id: "u1", at, text: "Fix it" },
			{ t: "assistant", id: "a1", at, text: "", reasoning: "Look first.", stop: "tool", toolCalls: [] },
			tool("r1", "read", "geom.py"),
			tool("r2", "read", "test.py"),
			tool("s1", "shell", "pytest"),
			tool("e1", "edit", "src/geom.py"),
			{ t: "assistant", id: "a2", at, text: "Fixed.", stop: "end" },
		] as SessionEvent[];
		const out = blocks(events, undefined);
		expect(out.map((b) => b.kind)).toEqual(["prompt", "thinking", "activity", "answer"]);
		const activity = out[2]!;
		expect(activity.kind === "activity" && summarize(activity.steps)).toBe("Read 2 files, ran 1 command, edited geom.py");
	});
});

describe("data", () => {
	test("CSV with quotes and missing values becomes typed columns; filters and stats work", async () => {
		expect(parseDelimited('a,b\n"x, y",2\n', ",")).toEqual([["a", "b"], ["x, y", "2"]]);
		const table = await readTable({ name: "m.csv", text: "plot,yield\nA,1.5\nB,NA\nC,3.5\n" });
		expect(table.columns.map((c) => c.type)).toEqual(["text", "number"]);
		const y = table.columns[1]!;
		expect(stats(y)).toMatchObject({ present: 2, missing: 1, min: 1.5, max: 3.5, mean: 2.5 });
		expect(y.values.filter(matcher(y, "> 2")!)).toEqual([3.5]);
	});
});
