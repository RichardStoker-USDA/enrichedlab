// Boundaries around where work runs: credential folders, the sandbox console, and labs that keep data inside.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Terminals } from "../packages/engine/src/terminal.ts";
import { showTool } from "../packages/engine/src/tools/harness.ts";
import { LocalWorkspace, type Workspace } from "../packages/engine/src/tools/workspace.ts";

const made: string[] = [];
function scratch(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `lab-${name}-`));
	made.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("credential folders", () => {
	// Bun's homedir() ignores a changed HOME, so this uses the real ~/.ssh path with a name that doesn't exist and
	// never writes: the guard refuses before any file is touched.
	test("file tools refuse ~/.ssh by path and through a link in the project", async () => {
		const project = scratch("project");
		symlinkSync(join(homedir(), ".ssh"), join(project, "keys"));
		const ws = new LocalWorkspace(project);
		await expect(ws.read("~/.ssh/enriched_absent")).rejects.toThrow("never reads or writes");
		await expect(ws.read("keys/enriched_absent")).rejects.toThrow("never reads or writes");
		if (existsSync(join(homedir(), ".ssh"))) expect(await ws.stat("keys")).toBeUndefined();
		writeFileSync(join(project, "notes.md"), "fine");
		expect((await ws.read("notes.md")).toString()).toBe("fine");
	});
});

describe("sandbox console", () => {
	test("stderr is shown and the folder survives it", async () => {
		const commands: string[] = [];
		const fake = {
			kind: "sandbox",
			root: "/sandbox/work/p",
			async exec(command: string) {
				commands.push(command);
				const marker = command.match(/__enriched_cwd_\w+/)![0];
				return { exitCode: 1, timedOut: false, output: `listed\n\n${marker}/sandbox/work/p/sub\nls: cannot access 'x'` };
			},
		} as unknown as Workspace;
		let shown = "";
		const terms = new Terminals((_name, params) => void (shown += params.data ?? ""));
		const { termId } = terms.start(fake, "EnrichedLab", 80, 24);
		terms.input(termId, "cd sub; ls x\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(shown).toContain("listed");
		expect(shown).toContain("cannot access 'x'");
		expect(shown).toContain("EnrichedLab\x1b[0m:~/sub$ ");
		terms.input(termId, "\x1b[Apwd\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(commands[1]).toContain("cd '/sandbox/work/p/sub' && { pwd\n}");
		terms.closeAll();
	});
});

describe("isolated labs", () => {
	test("show refuses addresses in a sealed session", async () => {
		const ctx = { sessionId: "s", sealed: true, project: "/p" } as never;
		await expect(showTool.run({ title: "App", url: "https://example.org" }, ctx)).rejects.toThrow("keeps its data inside");
	});
});
