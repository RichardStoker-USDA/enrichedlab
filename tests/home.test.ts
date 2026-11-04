// Releases before 0.2 kept settings in ~/.enriched; the first run of `el` moves them to ~/.el once.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveOldHome } from "../packages/engine/src/paths.ts";

describe("settings folder", () => {
	test("moves once, rewrites saved paths, and never overwrites a folder already there", () => {
		const root = mkdtempSync(join(tmpdir(), "lab-home-"));
		const from = join(root, ".enriched");
		const to = join(root, ".el");
		mkdirSync(join(from, "sessions"), { recursive: true });
		writeFileSync(join(from, "config.json"), JSON.stringify({ providers: { x: { keyFile: "~/.enriched/credentials/x.key" } } }));
		writeFileSync(join(from, "apps.json"), JSON.stringify({ known: { a: { dir: `${from}/apps/a` } } }));
		moveOldHome(from, to);
		expect(existsSync(from)).toBe(false);
		expect(JSON.parse(readFileSync(join(to, "apps.json"), "utf8")).known.a.dir).toBe(`${to}/apps/a`);
		expect(JSON.parse(readFileSync(join(to, "config.json"), "utf8")).providers.x.keyFile).toBe("~/.el/credentials/x.key");

		mkdirSync(join(from, "sessions"), { recursive: true });
		writeFileSync(join(from, "config.json"), "{}");
		moveOldHome(from, to);
		expect(existsSync(join(from, "config.json"))).toBe(true);
		rmSync(root, { recursive: true, force: true });
	});

	test("a new folder with nothing of the person's in it takes the old folder's contents", () => {
		const root = mkdtempSync(join(tmpdir(), "lab-home-"));
		const from = join(root, ".enriched");
		const to = join(root, ".el");
		mkdirSync(join(from, "sessions", "s1"), { recursive: true });
		writeFileSync(join(from, "config.json"), "{}");
		mkdirSync(join(to, "run"), { recursive: true });
		moveOldHome(from, to);
		expect([existsSync(join(to, "config.json")), existsSync(join(to, "sessions", "s1")), existsSync(join(to, "run")), existsSync(from)]).toEqual([true, true, true, false]);
		rmSync(root, { recursive: true, force: true });
	});
});
