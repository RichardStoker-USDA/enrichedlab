// The agent's app tools. app_create scaffolds an app in the project; the agent then edits its files like any code.
// app_open shows it in the person's workbench, where it reloads as files change. See docs/apps.md.

import { join } from "node:path";
import { APP_NAME } from "../apps/manifest.ts";
import { type Template, TEMPLATES, templateFiles } from "../apps/templates.ts";
import { str, type Tool, ToolError } from "./types.ts";

const folder = (name: string) => join("apps", name);

export const appCreateTool: Tool = {
	name: "app_create",
	kind: "write",
	description: [
		"Start a web app in the project, at apps/<name>/, that the person uses in a workbench pane beside this conversation.",
		"Templates: data (default: reads a table from the project, draws it on the GPU with an interactive plot, and has a backend tool), blank (a page), shiny (an R Shiny app), shiny-python (a Python Shiny app). Shiny apps carry a pixi.toml: their R or Python packages install per user from conda-forge on first open, no administrator needed; add packages there.",
		"After creating it, edit its files with the file tools and call app_open. Pages import /app-sdk/lab.js: connect(), lab.table(path), lab.call(tool, args), lab.run(command), lab.ask(prompt), lab.cluster(lab, command), lab.store, lab.share(text), and scatter(element, {x, y, color}) for WebGPU plots.",
		"A backend (app.json backend.runtime \"bun\") is a module exporting `tools`, run contained on the Bun runtime inside EnrichedLab; \"command\" and \"container\" run any MCP server on stdio; \"serve\" runs a web server on $PORT.",
		"What the page may do is declared in app.json permissions (files: read|write, commands, models, labs: [site], network: [origin]); the person allows it when it opens.",
	].join(" "),
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "lowercase-with-dashes" },
			title: { type: "string" },
			description: { type: "string" },
			template: { type: "string", enum: TEMPLATES },
		},
		required: ["name"],
	},
	view: (args) => ({ verb: "Create app", target: folder(String(args.name ?? "")) }),
	touches: (args) => Object.keys(templateFiles((args.template as Template) ?? "data", String(args.name ?? "app"), "", "")).map((f) => join(folder(String(args.name ?? "app")), f)),
	async run(args, ctx) {
		const name = str(args, "name");
		if (!APP_NAME.test(name)) throw new ToolError("name: lowercase letters, digits and dashes.");
		if (ctx.place !== "local") throw new ToolError("Apps are built on this computer; move the session back first. Apps can still reach the lab with lab.cluster().");
		const template = (str(args, "template", false) || "data") as Template;
		if (!TEMPLATES.includes(template)) throw new ToolError(`template is one of ${TEMPLATES.join(", ")}.`);
		const dir = folder(name);
		if (await ctx.workspace.stat(join(dir, "app.json"))) throw new ToolError(`${dir} already has an app; edit it instead.`);
		const title = str(args, "title", false) || name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
		const files = templateFiles(template, name, title, str(args, "description", false));
		for (const [path, body] of Object.entries(files)) await ctx.workspace.write(join(dir, path), body);
		return {
			ok: true,
			content: `Created ${dir} from the ${template} template: ${Object.keys(files).join(", ")}. Edit the files, then app_open ${dir} to show it; it reloads as files change.`,
			view: { result: `${Object.keys(files).length} files` },
		};
	},
};

export const appOpenTool: Tool = {
	name: "app_open",
	kind: "local",
	description: "Show an app (a folder with an app.json, such as apps/<name>) in the person's workbench. Open views reload when its files change, so open it once and keep editing. In a session that works in a lab, give the id of an installed app instead: its backend runs in the lab's sandbox.",
	parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	view: (args) => ({ verb: "Open app", target: String(args.path ?? "") }),
	async run(args, ctx) {
		if (!ctx.apps) throw new ToolError("Apps open in a session with the workbench.");
		const app = await ctx.apps.open(str(args, "path"));
		const asks = app.granted ? "" : " It asks the person for permissions first.";
		return { ok: true, content: `Opened ${app.title} (${app.id}) in the workbench.${asks}`, view: { result: app.title } };
	},
};
