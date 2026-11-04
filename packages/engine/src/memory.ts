// What the agent learns, kept for next time. Two tools, both visible as steps in the run:
//
//   remember      one line about this project or how the person works, added to its notes. The notes are part of
//                 the system prompt of every later session in that project.
//   skill_create  a finished multi-step workflow saved as a skill (SKILL.md) the person and agent can reuse. It asks,
//                 since it writes outside the project.
//
// Notes live in ~/.el/memory/<project>-<hash>.md, never in the repository; the person can read and edit them.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./paths.ts";
import { str, type Tool, ToolError } from "./tools/types.ts";
import { redact } from "./util.ts";

const NOTES_MAX = 8 * 1024;

export function notesPath(projectRoot: string, home = paths()): string {
	const hash = createHash("sha256").update(projectRoot).digest("hex").slice(0, 8);
	return join(home.memory, `${basename(projectRoot).replace(/[^\w.-]/g, "_")}-${hash}.md`);
}

/** The notes for a project, newest kept when they grow past the limit. */
export function readNotes(projectRoot: string): string {
	const file = notesPath(projectRoot);
	if (!existsSync(file)) return "";
	const text = readFileSync(file, "utf8");
	return text.length > NOTES_MAX ? text.slice(text.indexOf("\n", text.length - NOTES_MAX) + 1) : text;
}

export const rememberTool: Tool = {
		name: "remember",
		kind: "local",
		description:
			"Save one line you learned that will help in later sessions in this project: how to build or test it, a convention, a correction or preference the person gave. Not secrets, not what the code already says, not this task's progress.",
		parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
		view: (a) => ({ verb: "remember", target: String(a.note ?? "") }),
		async run(args, ctx) {
			const note = str(args, "note").replace(/\s+/g, " ").trim();
			if (!note || note.length > 400) throw new ToolError("A note is one line under 400 characters.");
			if (/(api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/i.test(note)) throw new ToolError("Notes never hold secrets; name the file that holds it instead.");
			const file = notesPath(ctx.project);
			mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
			if (!existsSync(file)) writeFileSync(file, `# Notes for ${basename(ctx.project)}\n\n`, { mode: 0o600 });
			appendFileSync(file, `- ${note} (${new Date().toISOString().slice(0, 10)})\n`);
			return { ok: true, content: "Saved to this project's notes.", view: { result: "noted" } };
		},
};

export const skillCreateTool: Tool = {
	name: "skill_create",
	kind: "write",
	description:
		"Save a finished workflow the person will repeat as a skill in ~/.el/skills/<name>/SKILL.md: when to use it and the steps, commands and checks that worked. Offer this after a multi-step task; it asks the person.",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", description: "lowercase-with-dashes" },
			description: { type: "string", description: "One sentence: what it does and when to use it." },
			body: { type: "string", description: "Markdown: the steps, commands and checks." },
		},
		required: ["name", "description", "body"],
		additionalProperties: false,
	},
	view: (a) => ({ verb: "save skill", target: String(a.name ?? "") }),
	ask: (a) => `It saves the skill "${String(a.name ?? "")}" to ~/.el/skills for every project.`,
	async run(args) {
		const name = str(args, "name");
		if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new ToolError("Name skills with lowercase letters, digits and dashes.");
		if (redact(str(args, "body")) !== str(args, "body")) throw new ToolError("The skill holds something that looks like a secret; refer to credentials by file path.");
		const dir = join(paths().home, "skills", name);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const description = str(args, "description").replace(/\n/g, " ");
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${str(args, "body").trim()}\n`, { mode: 0o600 });
		return { ok: true, content: `Saved the skill ${name}. It's available in every session from now on.`, view: { result: "saved" } };
	},
};
