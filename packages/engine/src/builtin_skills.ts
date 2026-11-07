// Skills that come with EnrichedLab (packages/engine/skills): how to build figure apps, analyze data, make Office
// files, fill PDF forms, use a lab's desktop and do research at a lab. They're embedded in `el` and written to
// <home>/skills/builtin-<version>/ on first use, where the skill tool reads them like any other. A personal or project
// skill with the same name replaces one of these.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dataAnalysis from "../skills/data-analysis/SKILL.md" with { type: "text" };
import labDesktop from "../skills/lab-desktop/SKILL.md" with { type: "text" };
import labResearch from "../skills/lab-research/SKILL.md" with { type: "text" };
import officeDocuments from "../skills/office-documents/SKILL.md" with { type: "text" };
import pdfForms from "../skills/pdf-forms/SKILL.md" with { type: "text" };
import shinyFigures from "../skills/shiny-figures/SKILL.md" with { type: "text" };
import { paths } from "./paths.ts";
import { VERSION } from "./util.ts";

export const BUILTIN_SKILLS: Record<string, string> = {
	"data-analysis": dataAnalysis,
	"lab-desktop": labDesktop,
	"lab-research": labResearch,
	"office-documents": officeDocuments,
	"pdf-forms": pdfForms,
	"shiny-figures": shinyFigures,
};

/** The folder holding this version's built-in skills, written once. */
export function builtinSkillsDir(home = paths().home): string {
	const dir = join(home, "skills", `builtin-${VERSION}`);
	for (const [name, text] of Object.entries(BUILTIN_SKILLS)) {
		const file = join(dir, name, "SKILL.md");
		if (existsSync(file)) continue;
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(file, text);
	}
	return dir;
}
