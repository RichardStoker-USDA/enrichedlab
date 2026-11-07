// The tool catalog (packages/engine/src/catalog.ts): each tool described for search, a request offered its core tools
// plus what the agent found once a session has many, and find_tools answering in words an agent can act on.

import { describe, expect, test } from "bun:test";
import { CORE_TOOLS, Catalog, DEFER_ABOVE, entry, findTools, foundNames, offered } from "../packages/engine/src/catalog.ts";
import type { Tool } from "../packages/engine/src/tools/types.ts";

const tool = (name: string, description: string, properties: string[] = [], extra: Partial<Tool> = {}): Tool => ({
	name,
	description,
	kind: "read",
	parameters: { type: "object", properties: Object.fromEntries(properties.map((p) => [p, { type: "string" }])), required: properties.slice(0, 1) },
	view: () => ({ verb: name, target: "" }),
	run: async () => ({ ok: true, content: "" }),
	...extra,
});

const tools: Tool[] = [
	tool("read", "Read a file in the project. Returns numbered lines.", ["path"]),
	tool("shell", "Run a shell command in the project folder.", ["command"]),
	tool("pdf_fill", "Fill a PDF form's fields and save the filled copy. Use pdf_fields first to see the field names.", ["path", "values"]),
	tool("pdf_fields", "List a PDF form's fields, with their types and current values.", ["path"]),
	tool("browser_click", "Click a control on the open web page, by its number from browser_read.", ["ref"]),
	tool("home_desktop", "Act on the lab's desktop sandbox: take a screenshot, click, type, scroll. Coordinates are pixels on the screenshot.", ["action"], { site: "home" }),
	tool("show", "Show a table, plot or page in the workbench: CSV and Parquet open as tables; a plot draws two columns.", ["path"]),
	tool("home_papers_search", "Search the lab's paper library by topic, author or DOI; returns citations with links.", ["query"], { site: "home" }),
];

describe("the catalog", () => {
	test("each tool gets a summary, its domains and its arguments", () => {
		const e = entry(tools.find((t) => t.name === "pdf_fill")!);
		expect(e.summary).toBe("Fill a PDF form's fields and save the filled copy.");
		expect(e.tags).toContain("pdf");
		expect(e.args).toEqual(["path", "values"]);
		expect(entry(tools.find((t) => t.name === "home_desktop")!).tags).toEqual(expect.arrayContaining(["desktop", "lab", "sandbox"]));
	});

	test("search finds the tool a scientist's words describe", () => {
		const catalog = new Catalog(tools.map(entry));
		expect(catalog.search("fill out a pdf form")[0]?.entry.name).toBe("pdf_fill");
		expect(catalog.search("click a button on a web page")[0]?.entry.name).toBe("browser_click");
		expect(catalog.search("screenshot of the lab desktop")[0]?.entry.name).toBe("home_desktop");
		expect(catalog.search("plot my csv data")[0]?.entry.name).toBe("show");
		expect(catalog.search("find papers about soil nitrogen")[0]?.entry.name).toBe("home_papers_search");
		expect(catalog.search("the")).toEqual([]);
	});

	test("a session with many tools is offered its core tools and what the agent found", () => {
		const many: Tool[] = [...tools, ...Array.from({ length: DEFER_ABOVE }, (_, i) => tool(`lab_tool_${i}`, `Lab tool number ${i}.`))];
		many.push(findTools((): Tool[] => many));
		const names = offered(many, new Set(["pdf_fill"])).map((t) => t.name);
		expect(names).toContain("find_tools");
		expect(names).toContain("pdf_fill");
		expect(names).not.toContain("lab_tool_3");
		expect(names.every((n) => CORE_TOOLS.has(n) || n === "pdf_fill")).toBe(true);
		// A few tools: all of them, and no find_tools.
		expect(offered(tools, new Set()).map((t) => t.name)).toEqual(tools.map((t) => t.name));
	});

	test("find_tools answers with the tools and their arguments, and its names read back", async () => {
		const find = findTools(() => tools);
		const answer = await find.run({ query: "fill a pdf form", limit: 2 }, {} as never);
		expect(answer.content).toStartWith("Available from your next step:");
		expect(answer.content).toContain("- `pdf_fill`: Fill a PDF form's fields and save the filled copy. Arguments: path, values.");
		expect(foundNames(answer.content)).toEqual(["pdf_fill", "pdf_fields"]);
		const none = await find.run({ query: "zzzz qqqq" }, {} as never);
		expect(none.content).toContain("The tools here cover:");
	});
});
