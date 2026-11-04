// Skills: folders with a SKILL.md (front matter `name` and `description`, then instructions) that the model loads
// when a task calls for one. The system prompt lists them; the `skill` tool returns one's instructions and files.
// The same layout as Claude Code and Codex skills, so a skill written for one works here.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { str, type Tool, ToolError } from "./tools/types.ts";
import { expandHome } from "./util.ts";

export interface Skill {
	name: string;
	description: string;
	dir: string;
}

/** Folders searched, in order; a later skill with the same name replaces an earlier one (project over personal). */
export function skillDirs(configured: string[], projectRoot: string): string[] {
	return configured.map((d) => (d.startsWith("~") || isAbsolute(d) ? expandHome(d) : join(projectRoot, d)));
}

export function findSkills(dirs: string[]): Skill[] {
	const found = new Map<string, Skill>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			const file = join(dir, name, "SKILL.md");
			if (!existsSync(file)) continue;
			const meta = frontMatter(readFileSync(file, "utf8"));
			const skill = { name: meta.name || name, description: meta.description || "", dir: join(dir, name) };
			found.set(skill.name, skill);
		}
	}
	return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function frontMatter(text: string): Record<string, string> {
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
	const out: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
		if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").trim();
	}
	return out;
}

/** The `skill` tool for a session's skills. */
export function skillTool(skills: () => Skill[]): Tool {
	return {
		name: "skill",
		kind: "read",
		description: "Load a skill's instructions by name (the skills are listed in the system prompt). Returns its SKILL.md and the files beside it; read those with read when the instructions point to them.",
		parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
		view: (a) => ({ verb: "skill", target: String(a.name ?? "") }),
		async run(args) {
			const name = str(args, "name");
			const skill = skills().find((s) => s.name === name);
			if (!skill) throw new ToolError(`No skill named ${name}. Known: ${skills().map((s) => s.name).join(", ") || "none"}.`);
			const body = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
			const files = listFiles(skill.dir).filter((f) => f !== "SKILL.md");
			return {
				ok: true,
				content: `${body}\n\n---\nSkill folder: ${skill.dir}${files.length ? `\nFiles: ${files.join(", ")}` : ""}`,
				view: { result: `${body.split("\n").length} lines` },
			};
		},
	};
}

function listFiles(dir: string, limit = 60): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if (out.length >= limit || name.startsWith(".")) continue;
			const full = join(d, name);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(relative(dir, full));
		}
	};
	walk(dir);
	return out;
}
