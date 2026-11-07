// Built-in skills (packages/engine/skills): embedded in el, written once per version, found like any other skill,
// and replaced by a personal or project skill of the same name.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SKILLS, builtinSkillsDir } from "../packages/engine/src/builtin_skills.ts";
import { findSkills } from "../packages/engine/src/skills.ts";

const home = mkdtempSync(join(tmpdir(), "el-skills-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("built-in skills are written once and found, and a personal skill of the same name wins", () => {
	const dir = builtinSkillsDir(home);
	const found = findSkills([dir]);
	expect(found.map((s) => s.name).sort()).toEqual(Object.keys(BUILTIN_SKILLS).sort());
	for (const skill of found) expect(skill.description.length).toBeGreaterThan(60);
	const personal = join(home, "mine");
	mkdirSync(join(personal, "pdf-forms"), { recursive: true });
	writeFileSync(join(personal, "pdf-forms", "SKILL.md"), "---\nname: pdf-forms\ndescription: my own way\n---\n");
	expect(findSkills([dir, personal]).find((s) => s.name === "pdf-forms")?.description).toBe("my own way");
});
