import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { quoteArg } from "../packages/engine/src/tools/windows_contain.ts";
import { contained } from "../packages/engine/src/tools/workspace.ts";

describe("Windows command lines", () => {
	test("arguments survive quoting", () => {
		expect(quoteArg("plain")).toBe("plain");
		expect(quoteArg("two words")).toBe('"two words"');
		expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
		expect(quoteArg("C:\\path with space\\")).toBe('"C:\\path with space\\\\"');
		expect(quoteArg("")).toBe('""');
	});
});

describe.if(process.platform === "win32")("Windows containment", () => {
	test("writes inside the project, not elsewhere in the home folder", () => {
		const project = mkdtempSync(join(tmpdir(), "contain-"));
		const outside = join(homedir(), "contain_outside_codetestfile.txt");
		try {
			const run = (command: string) => {
				const c = contained("cmd.exe", ["/d", "/c", command], { writable: [project], network: "none" });
				expect(c.facility).toBe("restricted-token");
				return Bun.spawnSync([c.file, ...c.args], { cwd: project });
			};
			expect(run(`echo inside> "${join(project, "a.txt")}"`).exitCode).toBe(0);
			expect(readFileSync(join(project, "a.txt"), "utf8").trim()).toBe("inside");
			run(`echo outside> "${outside}"`);
			expect(() => readFileSync(outside)).toThrow();
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(outside, { force: true });
		}
	}, 60_000);
});
